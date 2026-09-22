/*
 * 判定层：纯规则，不读写记录、不碰页面。
 * 录入校验、复核判定、筛选/对照/排序等派生结果全部在此计算。
 */
(function () {
  "use strict";

  var TEMP_TOLERANCE = 5; // 初测与复测允许的最大温差（℃），超过即退回返测

  var STATUS = {
    pending: { text: "待复核" },
    approved: { text: "复核通过" },
    returned: { text: "退回返测" }
  };

  function cleanText(value) {
    return String(value == null ? "" : value).trim();
  }

  function toNumber(value) {
    if (value === null || value === undefined) return NaN;
    var text = String(value).trim();
    if (text === "") return NaN;
    var num = Number(text);
    return Number.isFinite(num) ? num : NaN;
  }

  function round1(num) {
    return Math.round(num * 10) / 10;
  }

  // 矿物 + 片内位置 构成一个测点的键
  function pointKey(mineral, position) {
    return cleanText(mineral) + "" + cleanText(position);
  }

  /*
   * 测点录入/更正判定：
   * 测点（矿物+位置）、均一温度、爆裂温度缺项，或爆裂温度不高于均一温度时，整条拒绝。
   */
  function validateMeasurement(input) {
    var errors = [];
    var mineral = cleanText(input.mineral);
    var position = cleanText(input.position);
    var operator = cleanText(input.operator);
    var th = toNumber(input.th);
    var td = toNumber(input.td);

    if (!mineral) errors.push("矿物缺项");
    if (!position) errors.push("片内位置缺项");
    if (!operator) errors.push("测量人缺项");
    if (!Number.isFinite(th)) errors.push("均一温度缺项或不是数值");
    if (!Number.isFinite(td)) errors.push("爆裂温度缺项或不是数值");
    if (Number.isFinite(th) && Number.isFinite(td) && td <= th) {
      errors.push("爆裂温度须高于均一温度");
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      value: { mineral: mineral, position: position, operator: operator, th: round1(th), td: round1(td) }
    };
  }

  // 复测录入判定：复核人、复测温度缺一不可，温度关系同样必须合法
  function validateReviewInput(input) {
    var errors = [];
    var reviewer = cleanText(input.reviewer);
    var th = toNumber(input.th);
    var td = toNumber(input.td);

    if (!reviewer) errors.push("复核人缺项");
    if (!Number.isFinite(th)) errors.push("复测均一温度缺项或不是数值");
    if (!Number.isFinite(td)) errors.push("复测爆裂温度缺项或不是数值");
    if (Number.isFinite(th) && Number.isFinite(td) && td <= th) {
      errors.push("爆裂温度须高于均一温度");
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      value: { reviewer: reviewer, th: round1(th), td: round1(td) }
    };
  }

  /*
   * 复核判定：
   * 1. 必须换人，复核人不能与初测人为同一人；
   * 2. 均一或爆裂任一温差超过 5℃，只能退回返测，否则通过。
   */
  function decideReview(point, review) {
    if (review.reviewer === point.operator) {
      return { ok: false, errors: ["复核须换人：复核人不能与测量人为同一人"] };
    }
    var deltaTh = round1(review.th - point.th);
    var deltaTd = round1(review.td - point.td);
    var overTolerance = Math.abs(deltaTh) > TEMP_TOLERANCE || Math.abs(deltaTd) > TEMP_TOLERANCE;
    return {
      ok: true,
      result: overTolerance ? "return" : "pass",
      deltaTh: deltaTh,
      deltaTd: deltaTd
    };
  }

  /* ---- 以下为只读派生：筛选、对照、排序全部从同一份记录推导 ---- */

  function pointsOfSlide(state, sampleId) {
    return state.points
      .filter(function (point) { return point.sampleId === sampleId; })
      // 更正矿物/位置后按新键自然重排
      .sort(function (a, b) {
        var byMineral = a.mineral.localeCompare(b.mineral, "zh-Hans-CN");
        if (byMineral) return byMineral;
        var byPosition = a.position.localeCompare(b.position, "zh-Hans-CN");
        if (byPosition) return byPosition;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }

  function pendingPointOfSlide(state, sampleId) {
    for (var i = 0; i < state.points.length; i += 1) {
      var point = state.points[i];
      if (point.sampleId === sampleId && point.status === "pending") return point;
    }
    return null;
  }

  function sampleMatchesFilters(state, sample) {
    var filters = state.filters || {};
    var mineral = cleanText(filters.mineral);
    if (mineral && sample.minerals.indexOf(mineral) === -1) return false;
    if (filters.polarization && sample.polarization !== filters.polarization) return false;

    if (filters.reviewStatus) {
      var points = state.points.filter(function (p) { return p.sampleId === sample.id; });
      if (filters.reviewStatus === "none") {
        if (points.length) return false;
      } else if (!points.some(function (p) { return p.status === filters.reviewStatus; })) {
        return false;
      }
    }
    return true;
  }

  function visibleSamples(state) {
    return state.samples.filter(function (sample) { return sampleMatchesFilters(state, sample); });
  }

  // 并排对照只取仍存在的薄片，删除/刷新后对照状态保持一致
  function compareList(state) {
    return state.compare
      .map(function (id) {
        return state.samples.filter(function (sample) { return sample.id === id; })[0] || null;
      })
      .filter(Boolean)
      .slice(0, 2);
  }

  window.Domain = {
    TEMP_TOLERANCE: TEMP_TOLERANCE,
    STATUS: STATUS,
    pointKey: pointKey,
    validateMeasurement: validateMeasurement,
    validateReviewInput: validateReviewInput,
    decideReview: decideReview,
    pointsOfSlide: pointsOfSlide,
    pendingPointOfSlide: pendingPointOfSlide,
    visibleSamples: visibleSamples,
    compareList: compareList
  };
})();
