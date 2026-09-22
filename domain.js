/*
 * 判定层：包裹体测温复核的全部业务规则，纯函数，不接触 DOM 与 localStorage。
 * 记录层（store.js）与页面层（app.js）都只通过这里的结论行事。
 */
(function (root) {
  "use strict";

  // 两次测温允许的最大温差（℃），超过即退回返测
  var TOLERANCE = 5;

  var STATUS = {
    pending: "待复核",
    approved: "复核通过",
    returned: "退回返测"
  };

  function nonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  // 温度缺项返回 null；非有限数值同样视为缺项
  function readTemp(value) {
    if (value === "" || value === null || value === undefined) return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // 测点 = 薄片 + 矿物 + 位置；每片按矿物和位置只保留一个测点
  function pointKey(sampleId, mineral, position) {
    return sampleId + "::" + mineral.trim() + "::" + position.trim();
  }

  function hasPoint(points, sampleId, mineral, position, exceptId) {
    var key = pointKey(sampleId, mineral, position);
    return points.some(function (p) {
      return p.id !== exceptId && pointKey(p.sampleId, p.mineral, p.position) === key;
    });
  }

  /*
   * 初测/温度项写入前判定：
   * 矿物、位置、均一温度、爆裂温度任一缺项，或爆裂温度不高于均一温度，
   * 整条拒绝，不写入。
   */
  function validateMeasurement(input) {
    var errors = [];
    var mineral = String(input.mineral == null ? "" : input.mineral).trim();
    var position = String(input.position == null ? "" : input.position).trim();
    var th = readTemp(input.th);
    var td = readTemp(input.td);

    if (!mineral) errors.push("矿物缺项");
    if (!position) errors.push("测点位置缺项");
    if (th === null) errors.push("均一温度缺项");
    if (td === null) errors.push("爆裂温度缺项");
    if (th !== null && td !== null && td <= th) {
      errors.push("爆裂温度须高于均一温度");
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      value: { mineral: mineral, position: position, th: th, td: td }
    };
  }

  /*
   * 复核判定：
   * 1. 一个测点同时只允许一条待复核记录（非待复核状态不再受理）；
   * 2. 复核须换人；
   * 3. 复核温度同样必须齐全且爆裂高于均一，否则整条拒绝；
   * 4. 任一温度两次温差超过 5℃，只退回返测，不得通过。
   */
  function decideReview(point, input) {
    if (point.status !== "pending") {
      return { ok: false, errors: ["当前测点不处于待复核状态，不能重复复核"] };
    }
    var reviewer = String(input.reviewer == null ? "" : input.reviewer).trim();
    if (!reviewer) return { ok: false, errors: ["复核人缺项"] };
    if (reviewer === point.observer) {
      return { ok: false, errors: ["复核须换人：复核人不能与初测人为同一人"] };
    }

    var check = validateMeasurement({
      mineral: point.mineral,
      position: point.position,
      th: input.th,
      td: input.td
    });
    if (!check.ok) return { ok: false, errors: check.errors };

    var deltaTh = Math.abs(check.value.th - point.th);
    var deltaTd = Math.abs(check.value.td - point.td);
    var over = deltaTh > TOLERANCE || deltaTd > TOLERANCE;

    return {
      ok: true,
      reviewer: reviewer,
      th: check.value.th,
      td: check.value.td,
      deltaTh: deltaTh,
      deltaTd: deltaTd,
      result: over ? "returned" : "approved"
    };
  }

  /*
   * 更正判定：矿物、位置、温度按新值重排（换新键），
   * 新键若与同片另一测点冲突则拒绝；冲突时不写入、旧值继续保留。
   */
  function validateCorrection(points, point, input) {
    var check = validateMeasurement(input);
    if (!check.ok) return { ok: false, errors: check.errors };

    if (hasPoint(points, point.sampleId, check.value.mineral, check.value.position, point.id)) {
      return { ok: false, errors: ["该薄片下同矿物、同位置的测点已存在，不能重排到占用中的键"] };
    }
    return { ok: true, value: check.value };
  }

  // 按薄片顺序、矿物、位置排序；更正键值后据此“按新值重排”
  function orderPoints(points, sampleOrder) {
    return points.slice().sort(function (a, b) {
      var oa = Object.prototype.hasOwnProperty.call(sampleOrder, a.sampleId) ? sampleOrder[a.sampleId] : 9999;
      var ob = Object.prototype.hasOwnProperty.call(sampleOrder, b.sampleId) ? sampleOrder[b.sampleId] : 9999;
      if (oa !== ob) return oa - ob;
      var byMineral = a.mineral.localeCompare(b.mineral, "zh", { numeric: true });
      if (byMineral !== 0) return byMineral;
      return a.position.localeCompare(b.position, "zh", { numeric: true });
    });
  }

  root.ThermoDomain = {
    TOLERANCE: TOLERANCE,
    STATUS: STATUS,
    readTemp: readTemp,
    nonEmpty: nonEmpty,
    pointKey: pointKey,
    hasPoint: hasPoint,
    validateMeasurement: validateMeasurement,
    decideReview: decideReview,
    validateCorrection: validateCorrection,
    orderPoints: orderPoints
  };
})(typeof window !== "undefined" ? window : globalThis);
