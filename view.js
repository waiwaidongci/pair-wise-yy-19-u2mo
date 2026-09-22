/*
 * 页面层：只把记录渲染成 HTML，不做判定、不改记录。
 * 筛选、对照、测温面板全部从 Store.state 经 Domain 派生渲染，
 * 保证筛选/对照/刷新后看到的状态一致。
 */
(function () {
  "use strict";

  var TOL = Domain.TEMP_TOLERANCE;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(iso) {
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function signed(num) {
    return (num > 0 ? "+" : "") + num.toFixed(1);
  }

  function draftValue(drafts, pointId, field, fallback) {
    if (drafts[pointId] && drafts[pointId][field] !== undefined) return esc(drafts[pointId][field]);
    return fallback === undefined ? "" : esc(fallback);
  }

  function messageHtml(ui, scope) {
    if (!ui || ui.scope !== scope) return "";
    return '<p class="ui-msg ' + (ui.ok ? "ok" : "err") + '">' +
      (ui.ok ? "" : "❌ ") + esc(ui.text) + "</p>";
  }

  function historyText(entry) {
    if (entry.type === "create") return "测点建档，进入待复核";
    if (entry.type === "review") {
      if (entry.result === "return") {
        return "复核人 " + entry.review.reviewer + " 复测，温差超出 " + TOL + "℃（均一 " +
          signed(entry.review.deltaTh) + "℃、爆裂 " + signed(entry.review.deltaTd) + "℃），退回返测";
      }
      return "复核人 " + entry.review.reviewer + " 复测温差在 " + TOL + "℃ 内，复核通过";
    }
    if (entry.type === "correct") {
      var old = entry.old;
      var oldReview = old.review
        ? "，原复核" + (old.review.result === "pass" ? "通过" : "退回") + "（复核人 " + old.review.reviewer + "）与复测对照作废"
        : "";
      return "更正：矿物 " + old.mineral + " → 见新值；位置 " + old.position +
        "；初测均一/爆裂 " + old.th + "/" + old.td + "℃" + oldReview + "；旧值已留档，按新值重排待复核";
    }
    if (entry.type === "remeasure") {
      var ro = entry.old;
      var ret = ro.review
        ? "（复核人 " + ro.review.reviewer + " 复测温差超 " + TOL + "℃）"
        : "";
      return "返测登记：" + ro.operator + " 原测均一/爆裂 " + ro.th + "/" + ro.td + "℃" + ret +
        "；退回复核与对照作废留档，按新温度重新待复核";
    }
    return "";
  }

  function historyPanel(point) {
    if (!point.history.length) return "";
    var rows = point.history.map(function (entry) {
      return '<li><time>' + esc(fmtTime(entry.at)) + '</time><span>' + esc(historyText(entry)) + "</span></li>";
    }).join("");
    return '<details class="history"><summary>留档（' + point.history.length + "）</summary><ul>" + rows + "</ul></details>";
  }

  function comparisonBlock(point) {
    if (!point.review) {
      return '<p class="temp-compare pending-wait">待复核，尚无复测对照</p>';
    }
    var r = point.review;
    var overTh = Math.abs(r.deltaTh) > TOL;
    var overTd = Math.abs(r.deltaTd) > TOL;
    return '<div class="temp-compare">' +
      "<p>初测　均一 " + point.th.toFixed(1) + "℃　爆裂 " + point.td.toFixed(1) + "℃（" + esc(point.operator) + "）</p>" +
      "<p>复测　均一 " + r.th.toFixed(1) + "℃　爆裂 " + r.td.toFixed(1) + "℃（" + esc(r.reviewer) + "）</p>" +
      '<p class="deltas">温差　<span class="' + (overTh ? "over" : "within") + '">均一 ' +
        signed(r.deltaTh) + "℃</span>　<span class=\"" + (overTd ? "over" : "within") + '">爆裂 ' +
        signed(r.deltaTd) + "℃</span></p>" +
      "<p class=\"verdict\">判定：" + (r.result === "pass"
        ? '<span class="badge approved">复核通过</span>'
        : '<span class="badge returned">温差超 ' + TOL + "℃，退回返测</span>") + "</p>" +
      "</div>";
  }

  function reviewForm(sampleId, point, drafts, ui) {
    var scope = "review:" + sampleId + ":" + point.id;
    return '<form class="review-form" data-sample="' + sampleId + '" data-point="' + point.id + '" data-action="review">' +
      '<label>复核人（须与测量人不同）<input name="reviewer" required placeholder="换人复核" value="' +
        draftValue(drafts, scope, "reviewer") + '"></label>' +
      '<div class="pair">' +
      '<label>复测均一温度℃<input name="th" type="number" step="0.1" required value="' +
        draftValue(drafts, scope, "th") + '"></label>' +
      '<label>复测爆裂温度℃<input name="td" type="number" step="0.1" required value="' +
        draftValue(drafts, scope, "td") + '"></label>' +
      "</div>" +
      '<p class="hint">复核须换人；温差超过 ' + TOL + '℃ 只退回返测</p>' +
      messageHtml(ui, scope) +
      '<button type="submit">提交复核</button></form>';
  }

  function correctBox(sampleId, point, drafts, ui, open) {
    var scope = "correct:" + sampleId + ":" + point.id;
    return '<details class="correct-box"' + (open ? " open" : "") + '>' +
      "<summary>更正矿物 / 位置 / 温度</summary>" +
      '<form data-sample="' + sampleId + '" data-point="' + point.id + '" data-action="correct">' +
      "<label>矿物<input name=\"mineral\" required value=\"" +
        draftValue(drafts, scope, "mineral", point.mineral) + '"></label>' +
      "<label>片内位置<input name=\"position\" required value=\"" +
        draftValue(drafts, scope, "position", point.position) + '"></label>' +
      "<label>测量人<input name=\"operator\" required value=\"" +
        draftValue(drafts, scope, "operator", point.operator) + '"></label>' +
      '<div class="pair">' +
      "<label>均一温度℃<input name=\"th\" type=\"number\" step=\"0.1\" required value=\"" +
        draftValue(drafts, scope, "th", point.th) + '"></label>' +
      "<label>爆裂温度℃<input name=\"td\" type=\"number\" step=\"0.1\" required value=\"" +
        draftValue(drafts, scope, "td", point.td) + '"></label>' +
      "</div>" +
      '<p class="hint">更正后旧复核与复测对照作废、按新值重排，旧值留档</p>' +
      messageHtml(ui, scope) +
      '<button type="submit">保存更正并重排</button></form></details>';
  }

  function remeasureForm(sampleId, point, drafts, ui) {
    var scope = "remeasure:" + sampleId + ":" + point.id;
    return '<form class="review-form" data-sample="' + sampleId + '" data-point="' + point.id + '" data-action="remeasure">' +
      '<label>返测测量人<input name="operator" required value="' +
        draftValue(drafts, scope, "operator", point.operator) + '"></label>' +
      '<div class="pair">' +
      '<label>返测均一温度℃<input name="th" type="number" step="0.1" required value="' +
        draftValue(drafts, scope, "th") + '"></label>' +
      '<label>返测爆裂温度℃<input name="td" type="number" step="0.1" required value="' +
        draftValue(drafts, scope, "td") + '"></label>' +
      "</div>" +
      '<p class="hint">已退回返测：登记新温度后回到待复核，须重新换人复核</p>' +
      messageHtml(ui, scope) +
      '<button type="submit">登记返测并重排队复核</button></form>';
  }

  function pointItem(sampleId, point, drafts, ui) {
    var badge = '<span class="badge ' + point.status + '">' + Domain.STATUS[point.status].text + "</span>";
    var actionForm = point.status === "pending"
      ? reviewForm(sampleId, point, drafts, ui)
      : point.status === "returned"
        ? remeasureForm(sampleId, point, drafts, ui)
        : "";
    return '<li class="point-item">' +
      '<div class="point-head"><strong>' + esc(point.mineral) + "</strong>" +
      "<span>" + esc(point.position) + "</span>" + badge + "</div>" +
      comparisonBlock(point) +
      actionForm +
      correctBox(sampleId, point, drafts, ui, ui && ui.scope === "correct:" + sampleId + ":" + point.id) +
      historyPanel(point) +
      "</li>";
  }

  function addPointForm(sampleId, drafts, ui) {
    var scope = "add:" + sampleId;
    var pending = Domain.pendingPointOfSlide(Store.state, sampleId);
    if (pending) {
      return '<p class="hint lock-hint">本片已有待复核测点（' + esc(pending.mineral) + " · " +
        esc(pending.position) + "），请先完成复核再录新点；同一时刻仅保留一条待复核记录。</p>";
    }
    return '<form class="point-add" data-sample="' + sampleId + '" data-action="add">' +
      "<label>矿物<input name=\"mineral\" required placeholder=\"石英\" value=\"" +
        draftValue(drafts, scope, "mineral") + '"></label>' +
      "<label>片内位置<input name=\"position\" required placeholder=\"视域中偏左包体群 A\" value=\"" +
        draftValue(drafts, scope, "position") + '"></label>' +
      "<label>测量人<input name=\"operator\" required placeholder=\"初测人姓名\" value=\"" +
        draftValue(drafts, scope, "operator") + '"></label>' +
      '<div class="pair">' +
      "<label>均一温度℃<input name=\"th\" type=\"number\" step=\"0.1\" required value=\"" +
        draftValue(drafts, scope, "th") + '"></label>' +
      "<label>爆裂温度℃<input name=\"td\" type=\"number\" step=\"0.1\" required value=\"" +
        draftValue(drafts, scope, "td") + '"></label>' +
      "</div>" +
      '<p class="hint">每片按矿物+位置只保留一个测点；测点、均一/爆裂温度缺项或爆裂不高于均一，整条拒绝不写入</p>' +
      messageHtml(ui, scope) +
      '<button type="submit">保存测温点</button></form>';
  }

  function pointPanel(sampleId, drafts, ui) {
    var points = Domain.pointsOfSlide(Store.state, sampleId);
    var list = points.length
      ? '<ul class="point-list">' +
        points.map(function (p) { return pointItem(sampleId, p, drafts, ui); }).join("") +
        "</ul>"
      : '<p class="hint">尚无包裹体测温点。</p>';
    return '<section class="temp-panel"><h4>包裹体测温复核</h4>' + list + addPointForm(sampleId, drafts, ui) + "</section>";
  }

  function sampleCard(sample, drafts, ui) {
    var photo = sample.photo
      ? '<img src="' + sample.photo + '" alt="' + esc(sample.code) + '显微照片">'
      : '<div class="photo-placeholder"></div>';
    var checked = Store.state.compare.indexOf(sample.id) !== -1 ? " checked" : "";
    return '<article class="sample-card">' + photo +
      '<div class="sample-body">' +
      "<h3>" + esc(sample.code) + "</h3>" +
      "<p>" + esc(sample.location || "未记录地点") + " · " +
        esc(sample.magnification || "未记录倍数") + " · " + esc(sample.polarization) + "</p>" +
      "<p>矿物：" + esc(sample.minerals || "未记录") + "</p>" +
      "<p>结构：" + esc(sample.texture || "未记录") + "</p>" +
      "<p>" + esc(sample.comment || "未填写批注") + "</p>" +
      pointPanel(sample.id, drafts, ui) +
      '<div class="card-actions">' +
        '<label><input type="checkbox" data-compare="' + sample.id + '"' + checked + ">对比</label>" +
        '<button type="button" data-delete="' + sample.id + '">删除</button>' +
      "</div></div></article>";
  }

  function renderGrid(drafts, ui) {
    var rows = Domain.visibleSamples(Store.state);
    if (!rows.length) {
      return "<p>还没有样本，先从左侧录入一张薄片照片。</p>";
    }
    return '<div class="cards">' + rows.map(function (s) { return sampleCard(s, drafts || {}, ui); }).join("") + "</div>";
  }

  function renderCompare() {
    var list = Domain.compareList(Store.state);
    if (!list.length) return "<p>勾选两张样本卡片后可并排对比。</p>";
    return list.map(function (sample) {
      var points = Domain.pointsOfSlide(Store.state, sample.id);
      var pointHtml = points.length
        ? '<ul class="compare-points">' + points.map(function (p) {
            var tempLine = p.review
              ? "初测 " + p.th.toFixed(1) + "/" + p.td.toFixed(1) + "℃ · 复测 " +
                p.review.th.toFixed(1) + "/" + p.review.td.toFixed(1) + "℃"
              : "初测 " + p.th.toFixed(1) + "/" + p.td.toFixed(1) + "℃ · 待复核";
            return "<li><span class=\"badge " + p.status + "\">" + Domain.STATUS[p.status].text +
              "</span> " + esc(p.mineral) + " · " + esc(p.position) +
              '<small>' + tempLine + "</small></li>";
          }).join("") + "</ul>"
        : '<p class="hint">无测温点</p>';
      return '<article class="compare-item">' +
        (sample.photo ? '<img src="' + sample.photo + '" alt="' + esc(sample.code) + '对比图">' : "") +
        "<h3>" + esc(sample.code) + "</h3>" +
        "<p>" + esc(sample.polarization) + " · " + esc(sample.minerals || "未记录矿物") + "</p>" +
        "<p>" + esc(sample.texture || "未记录结构") + "</p>" +
        "<h4>测温对照</h4>" + pointHtml +
        "</article>";
    }).join("");
  }

  window.View = {
    esc: esc,
    renderGrid: renderGrid,
    renderCompare: renderCompare
  };
})();
