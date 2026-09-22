/*
 * 记录层：唯一读写 localStorage 的地方。
 * 规则判定全部委托 domain.js，本层只负责写入、留档、排序与状态持久化，
 * 不包含任何 DOM 操作。
 */
(function (root) {
  "use strict";

  var D = root.ThermoDomain;
  var storageKey = "wxyy-2-thin-section-index";

  function load() {
    var state = JSON.parse(localStorage.getItem(storageKey) || '{"samples":[],"compare":[]}');
    // 兼容旧存档：补出包裹体测点相关字段
    if (!Array.isArray(state.samples)) state.samples = [];
    if (!Array.isArray(state.points)) state.points = [];
    if (!Array.isArray(state.compare)) state.compare = [];
    return state;
  }

  var state = load();

  function save() {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  function pruneCompare() {
    state.compare = state.compare.filter(function (entry) {
      if (entry.kind === "point") {
        return state.points.some(function (p) { return p.id === entry.id; });
      }
      return state.samples.some(function (s) { return s.id === entry.id; });
    });
  }

  function sampleOrder() {
    var order = {};
    state.samples.forEach(function (s, i) { order[s.id] = i; });
    return order;
  }

  function reorderPoints() {
    state.points = D.orderPoints(state.points, sampleOrder());
  }

  function findSample(sampleId) {
    return state.samples.find(function (s) { return s.id === sampleId; });
  }

  function findPoint(pointId) {
    return state.points.find(function (p) { return p.id === pointId; });
  }

  function pointsForSample(sampleId) {
    return state.points.filter(function (p) { return p.sampleId === sampleId; });
  }

  function addSample(sample) {
    state.samples.unshift(sample);
    reorderPoints();
    save();
  }

  function removeSample(sampleId) {
    state.samples = state.samples.filter(function (s) { return s.id !== sampleId; });
    // 删片连带删除其全部测点，对照选中一并清掉
    state.points = state.points.filter(function (p) { return p.sampleId !== sampleId; });
    pruneCompare();
    reorderPoints();
    save();
  }

  /*
   * 新增测点：判定不过整条拒绝，不写入、不留档。
   */
  function addPoint(input) {
    var sampleId = String(input.sampleId || "");
    if (!findSample(sampleId)) {
      return { ok: false, errors: ["请先选择薄片"] };
    }
    var check = D.validateMeasurement(input);
    if (!check.ok) return { ok: false, errors: check.errors };

    if (D.hasPoint(state.points, sampleId, check.value.mineral, check.value.position, null)) {
      return { ok: false, errors: ["该薄片下同矿物、同位置的测点已存在"] };
    }

    var now = new Date().toISOString();
    var point = {
      id: crypto.randomUUID(),
      sampleId: sampleId,
      mineral: check.value.mineral,
      position: check.value.position,
      th: check.value.th,
      td: check.value.td,
      observer: String(input.observer || "").trim(),
      status: "pending",
      review: null,
      history: [
        {
          type: "create",
          at: now,
          by: String(input.observer || "").trim(),
          mineral: check.value.mineral,
          position: check.value.position,
          th: check.value.th,
          td: check.value.td
        }
      ],
      createdAt: now
    };
    state.points.push(point);
    reorderPoints();
    save();
    return { ok: true, point: point };
  }

  /*
   * 提交复核：一个测点同时只有一条待复核记录；
   * 换人 + 温差不超过 5℃ 才通过，否则按判定结果退回返测。
   */
  function submitReview(pointId, input) {
    var point = findPoint(pointId);
    if (!point) return { ok: false, errors: ["测点不存在"] };

    var decision = D.decideReview(point, input);
    if (!decision.ok) return { ok: false, errors: decision.errors };

    var now = new Date().toISOString();
    point.status = decision.result; // approved | returned
    point.review = {
      reviewer: decision.reviewer,
      th: decision.th,
      td: decision.td,
      deltaTh: decision.deltaTh,
      deltaTd: decision.deltaTd,
      at: now
    };
    point.history.push({
      type: decision.result === "approved" ? "review-approved" : "review-returned",
      at: now,
      by: decision.reviewer,
      th: decision.th,
      td: decision.td,
      deltaTh: decision.deltaTh,
      deltaTd: decision.deltaTd
    });
    // 退回返测：当前对照若基于旧复核，已失效，剔除该测点的对照选中
    if (decision.result === "returned") {
      state.compare = state.compare.filter(function (e) {
        return !(e.kind === "point" && e.id === pointId);
      });
    }
    save();
    return { ok: true, point: point };
  }

  /*
   * 更正矿物、位置或温度：旧复核与对照失效，按新值重排，旧值留档。
   */
  function correctPoint(pointId, input, corrector) {
    var point = findPoint(pointId);
    if (!point) return { ok: false, errors: ["测点不存在"] };

    var check = D.validateCorrection(state.points, point, input);
    if (!check.ok) return { ok: false, errors: check.errors };

    var now = new Date().toISOString();
    var supersededReview = point.review;

    // 旧值完整留档（含当时的复核结论）
    point.history.push({
      type: "correct",
      at: now,
      by: String(corrector || point.observer || "").trim(),
      old: {
        mineral: point.mineral,
        position: point.position,
        th: point.th,
        td: point.td,
        review: supersededReview ? {
          reviewer: supersededReview.reviewer,
          th: supersededReview.th,
          td: supersededReview.td,
          at: supersededReview.at
        } : null
      },
      next: {
        mineral: check.value.mineral,
        position: check.value.position,
        th: check.value.th,
        td: check.value.td
      }
    });

    point.mineral = check.value.mineral;
    point.position = check.value.position;
    point.th = check.value.th;
    point.td = check.value.td;
    point.status = "pending";
    point.review = null; // 旧复核作废，回到唯一一条待复核状态

    // 对照基于旧键/旧复核，已失效
    state.compare = state.compare.filter(function (e) {
      return !(e.kind === "point" && e.id === pointId);
    });

    reorderPoints();
    save();
    return { ok: true, point: point };
  }

  function removePoint(pointId) {
    state.points = state.points.filter(function (p) { return p.id !== pointId; });
    pruneCompare();
    save();
  }

  function toggleCompare(kind, id) {
    var ref = { kind: kind, id: id };
    var exists = state.compare.some(function (e) { return e.kind === kind && e.id === id; });
    if (exists) {
      state.compare = state.compare.filter(function (e) { return !(e.kind === kind && e.id === id); });
    } else {
      state.compare = [ref].concat(
        state.compare.filter(function (e) { return !(e.kind === kind && e.id === id); })
      ).slice(0, 2); // 样本与测点共用并排对照，最多两条
    }
    save();
  }

  function isComparing(kind, id) {
    return state.compare.some(function (e) { return e.kind === kind && e.id === id; });
  }

  function compareEntries() {
    return state.compare.map(function (entry) {
      if (entry.kind === "point") {
        var point = findPoint(entry.id);
        return point ? { kind: "point", point: point } : null;
      }
      var sample = state.samples.find(function (s) { return s.id === entry.id; });
      return sample ? { kind: "sample", sample: sample } : null;
    }).filter(Boolean);
  }

  save(); // 迁移后的结构立即落盘

  root.ThermoStore = {
    state: state,
    save: save,
    addSample: addSample,
    removeSample: removeSample,
    findSample: findSample,
    findPoint: findPoint,
    pointsForSample: pointsForSample,
    orderedPoints: function () { reorderPoints(); return state.points; },
    addPoint: addPoint,
    submitReview: submitReview,
    correctPoint: correctPoint,
    removePoint: removePoint,
    toggleCompare: toggleCompare,
    isComparing: isComparing,
    compareEntries: compareEntries
  };
})(window);
