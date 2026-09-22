/*
 * 记录层：记录唯一写口，所有判定结果来自 Domain。
 * 负责留档、更正后作废重排、localStorage 持久化；页面不直接改记录。
 */
(function () {
  "use strict";

  var storageKey = "wxyy-2-thin-section-index";

  function loadState() {
    var state = JSON.parse(localStorage.getItem(storageKey) || "null") || {};
    state.samples = Array.isArray(state.samples) ? state.samples : [];
    state.compare = Array.isArray(state.compare) ? state.compare : [];
    state.points = Array.isArray(state.points) ? state.points : [];
    state.filters = Object.assign({ mineral: "", polarization: "", reviewStatus: "" }, state.filters || {});

    // 刷新后对照状态与现存薄片保持一致
    var validIds = state.samples.map(function (s) { return s.id; });
    var pruned = state.compare.filter(function (id) { return validIds.indexOf(id) !== -1; }).slice(0, 2);
    var changed = pruned.length !== state.compare.length;
    state.compare = pruned;

    // 清掉属于已删除薄片的测温点
    var before = state.points.length;
    state.points = state.points.filter(function (p) { return validIds.indexOf(p.sampleId) !== -1; });
    if (state.points.length !== before) changed = true;
    if (changed) localStorage.setItem(storageKey, JSON.stringify(state));
    return state;
  }

  var state = loadState();

  function save() {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  function fail(result) {
    return result || { ok: false, errors: ["操作未通过判定"] };
  }

  function findSlide(sampleId) {
    return state.samples.filter(function (s) { return s.id === sampleId; })[0] || null;
  }

  function findPoint(sampleId, pointId) {
    return state.points.filter(function (p) { return p.sampleId === sampleId && p.id === pointId; })[0] || null;
  }

  function addSample(data, photo) {
    var sample = {
      id: crypto.randomUUID(),
      photo: photo,
      code: String(data.get("code") || "").trim(),
      location: String(data.get("location") || "").trim(),
      magnification: String(data.get("magnification") || "").trim(),
      polarization: data.get("polarization"),
      minerals: String(data.get("minerals") || "").trim(),
      texture: String(data.get("texture") || "").trim(),
      comment: String(data.get("comment") || "").trim(),
      createdAt: new Date().toISOString()
    };
    state.samples.unshift(sample);
    save();
    return { ok: true, sample: sample };
  }

  function deleteSample(sampleId) {
    state.samples = state.samples.filter(function (s) { return s.id !== sampleId; });
    state.compare = state.compare.filter(function (id) { return id !== sampleId; });
    state.points = state.points.filter(function (p) { return p.sampleId !== sampleId; });
    save();
    return { ok: true };
  }

  function toggleCompare(sampleId, checked) {
    if (checked) {
      state.compare = [sampleId].concat(
        state.compare.filter(function (id) { return id !== sampleId; })
      ).slice(0, 2);
    } else {
      state.compare = state.compare.filter(function (id) { return id !== sampleId; });
    }
    save();
  }

  function patchFilters(patch) {
    state.filters = Object.assign({}, state.filters, patch);
    save();
  }

  function archive(point, entry) {
    point.history.push(Object.assign({ at: new Date().toISOString() }, entry));
  }

  /*
   * 新增测点：
   * - 每片按矿物+位置只保留一个测点（同键拒绝，重名请更正原测点）；
   * - 同片同时仅允许一条待复核记录，有待复核测点时整条拒绝；
   * - 缺项或爆裂温度不高于均一温度由 Domain 判定拒绝，不写入。
   */
  function addMeasurement(sampleId, input) {
    if (!findSlide(sampleId)) return fail();

    var check = Domain.validateMeasurement(input);
    if (!check.ok) return fail(check);

    var value = check.value;
    var key = Domain.pointKey(value.mineral, value.position);
    var duplicate = state.points.some(function (p) {
      return p.sampleId === sampleId && Domain.pointKey(p.mineral, p.position) === key;
    });
    if (duplicate) {
      return fail({ ok: false, errors: ["该片内该矿物+位置的测点已存在，每片只保留一个"] });
    }
    if (Domain.pendingPointOfSlide(state, sampleId)) {
      return fail({ ok: false, errors: ["该片已有待复核记录，同一时刻仅允许一条；请先完成复核"] });
    }

    var now = new Date().toISOString();
    var point = {
      id: crypto.randomUUID(),
      sampleId: sampleId,
      mineral: value.mineral,
      position: value.position,
      operator: value.operator,
      th: value.th,
      td: value.td,
      status: "pending",
      review: null,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, type: "create" }]
    };
    state.points.push(point);
    save();
    return { ok: true, point: point };
  }

  /*
   * 复核（必须换人）：复测缺项/温度关系不合法不写入；
   * 温差超过 5℃ 只退回返测，不允许直接判通过。
   */
  function reviewMeasurement(sampleId, pointId, input) {
    var point = findPoint(sampleId, pointId);
    if (!point || point.status !== "pending") {
      return fail({ ok: false, errors: ["该测点不是待复核状态"] });
    }
    var check = Domain.validateReviewInput(input);
    if (!check.ok) return fail(check);

    var decision = Domain.decideReview(point, check.value);
    if (!decision.ok) return fail(decision);

    var passed = decision.result === "pass";
    point.review = {
      reviewer: check.value.reviewer,
      th: check.value.th,
      td: check.value.td,
      deltaTh: decision.deltaTh,
      deltaTd: decision.deltaTd,
      result: passed ? "pass" : "return",
      at: new Date().toISOString()
    };
    point.status = passed ? "approved" : "returned";
    point.updatedAt = point.review.at;
    archive(point, { type: "review", result: point.review.result, review: point.review });
    save();
    return { ok: true, point: point, decision: point.review.result };
  }

  /*
   * 更正矿物、位置或温度：
   * - 旧复核与对照立即作废，测点按新值回到待复核、重新排序；
   * - 旧值完整留档（含作废的复核与复测对照）；
   * - 新值同样要通过缺项/温度判定，同片仍只许一条待复核。
   */
  function correctMeasurement(sampleId, pointId, input) {
    var point = findPoint(sampleId, pointId);
    if (!point) return fail();

    var check = Domain.validateMeasurement(input);
    if (!check.ok) return fail(check);
    var value = check.value;

    var otherPending = state.points.some(function (p) {
      return p.sampleId === sampleId && p.id !== pointId && p.status === "pending";
    });
    if (otherPending) {
      return fail({ ok: false, errors: ["该片另有待复核记录，同一时刻仅允许一条"] });
    }

    var key = Domain.pointKey(value.mineral, value.position);
    var collision = state.points.some(function (p) {
      return p.sampleId === sampleId && p.id !== pointId && Domain.pointKey(p.mineral, p.position) === key;
    });
    if (collision) {
      return fail({ ok: false, errors: ["更正后的矿物+位置与同片另一个测点冲突"] });
    }

    var now = new Date().toISOString();
    archive(point, {
      type: "correct",
      old: {
        mineral: point.mineral,
        position: point.position,
        operator: point.operator,
        th: point.th,
        td: point.td,
        status: point.status,
        review: point.review
      }
    });

    point.mineral = value.mineral;
    point.position = value.position;
    point.operator = value.operator;
    point.th = value.th;
    point.td = value.td;
    point.status = "pending";
    point.review = null; // 旧复核与对照作废，等待新一轮换人复核
    point.updatedAt = now;
    save();
    return { ok: true, point: point };
  }

  /*
   * 返测登记（仅退回返测状态可用）：
   * 测量人重新测定，矿物与位置不变；原退回复核与复测对照作废、留档，回到待复核。
   */
  function remeasureMeasurement(sampleId, pointId, input) {
    var point = findPoint(sampleId, pointId);
    if (!point || point.status !== "returned") {
      return fail({ ok: false, errors: ["只有退回返测的测点需要返测登记"] });
    }
    var check = Domain.validateMeasurement({
      mineral: point.mineral,
      position: point.position,
      operator: input.operator,
      th: input.th,
      td: input.td
    });
    if (!check.ok) return fail(check);
    var value = check.value;

    var otherPending = state.points.some(function (p) {
      return p.sampleId === sampleId && p.id !== pointId && p.status === "pending";
    });
    if (otherPending) {
      return fail({ ok: false, errors: ["该片另有待复核记录，返测登记后会同现两条待复核，请先完成现有复核"] });
    }

    var now = new Date().toISOString();
    archive(point, {
      type: "remeasure",
      old: { operator: point.operator, th: point.th, td: point.td, review: point.review }
    });
    point.operator = value.operator;
    point.th = value.th;
    point.td = value.td;
    point.status = "pending";
    point.review = null; // 原退回复核与对照作废，等待重新换人复核
    point.updatedAt = now;
    save();
    return { ok: true, point: point };
  }

  window.Store = {
    state: state,
    findSlide: findSlide,
    findPoint: findPoint,
    save: save,
    addSample: addSample,
    deleteSample: deleteSample,
    toggleCompare: toggleCompare,
    patchFilters: patchFilters,
    addMeasurement: addMeasurement,
    reviewMeasurement: reviewMeasurement,
    remeasureMeasurement: remeasureMeasurement,
    correctMeasurement: correctMeasurement
  };
})();
