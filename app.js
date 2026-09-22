/*
 * 装配层：只负责 DOM 取值、事件分发与渲染。
 * 判定在 Domain，写入与留档在 Store，HTML 在 View。
 */
(function () {
  "use strict";

  var form = document.querySelector("#sampleForm");
  var photoInput = document.querySelector("#photoInput");
  var editorMsg = document.querySelector("#editorMsg");
  var sampleGrid = document.querySelector("#sampleGrid");
  var comparePane = document.querySelector("#comparePane");
  var mineralFilter = document.querySelector("#mineralFilter");
  var polarFilter = document.querySelector("#polarFilter");
  var reviewStatusFilter = document.querySelector("#reviewStatusFilter");

  var pendingPhoto = "";

  // 仅页面会话内有效的暂存：被拒表单回填、局部提示；刷新后清空
  var drafts = {};
  var ui = null;

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve) {
      if (!file) return resolve("");
      var reader = new FileReader();
      reader.addEventListener("load", function () { return resolve(reader.result); });
      reader.readAsDataURL(file);
    });
  }

  function render() {
    sampleGrid.innerHTML = View.renderGrid(drafts, ui);
    comparePane.innerHTML = View.renderCompare();
  }

  function keepDraft(scope, formEl) {
    var fields = ["mineral", "position", "operator", "th", "td", "reviewer"];
    drafts[scope] = {};
    fields.forEach(function (name) {
      var field = formEl.elements[name];
      if (field) drafts[scope][name] = field.value;
    });
  }

  function handlePointSubmit(event) {
    var formEl = event.target;
    var action = formEl.dataset.action;
    if (!action) return;
    event.preventDefault();

    var sampleId = formEl.dataset.sample;
    var pointId = formEl.dataset.point;
    var scope = action + ":" + sampleId + (pointId ? ":" + pointId : "");
    var data = new FormData(formEl);
    var input = {
      mineral: data.get("mineral"),
      position: data.get("position"),
      operator: data.get("operator"),
      th: data.get("th"),
      td: data.get("td"),
      reviewer: data.get("reviewer")
    };

    var result;
    if (action === "add") result = Store.addMeasurement(sampleId, input);
    if (action === "review") result = Store.reviewMeasurement(sampleId, pointId, input);
    if (action === "remeasure") result = Store.remeasureMeasurement(sampleId, pointId, input);
    if (action === "correct") result = Store.correctMeasurement(sampleId, pointId, input);

    if (result.ok) {
      delete drafts[scope];
      var text;
      if (action === "add") text = "测温点已保存，进入待复核";
      else if (action === "review") text = result.decision === "pass"
        ? "复核通过，复测对照已记录"
        : "温差超过 5℃，已退回返测";
      else if (action === "remeasure") text = "返测已登记，退回记录作废留档，重新等待换人复核";
      else text = "已按新值更正，旧复核与对照作废并留档，测点重排待复核";
      ui = { scope: scope, ok: true, text: text };
    } else {
      keepDraft(scope, formEl);
      ui = { scope: scope, ok: false, text: (result.errors || []).join("；") };
    }
    render();
  }

  photoInput.addEventListener("change", async function () {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var data = new FormData(form);
    if (!pendingPhoto && photoInput.files[0]) {
      pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
    }
    Store.addSample(data, pendingPhoto);
    pendingPhoto = "";
    photoInput.value = "";
    form.reset();
    editorMsg.textContent = "样本已保存。";
    render();
  });

  sampleGrid.addEventListener("submit", handlePointSubmit);

  sampleGrid.addEventListener("click", function (event) {
    var deleteId = event.target.dataset.delete;
    if (!deleteId) return;
    Store.deleteSample(deleteId);
    drafts = {};
    ui = null;
    render();
  });

  sampleGrid.addEventListener("change", function (event) {
    var id = event.target.dataset.compare;
    if (!id) return;
    Store.toggleCompare(id, event.target.checked);
    render();
  });

  // 筛选条件写入记录并持久化，刷新后保持一致
  mineralFilter.value = Store.state.filters.mineral || "";
  polarFilter.value = Store.state.filters.polarization || "";
  reviewStatusFilter.value = Store.state.filters.reviewStatus || "";

  function syncFilters() {
    Store.patchFilters({
      mineral: mineralFilter.value.trim(),
      polarization: polarFilter.value,
      reviewStatus: reviewStatusFilter.value
    });
    render();
  }
  mineralFilter.addEventListener("input", syncFilters);
  polarFilter.addEventListener("change", syncFilters);
  reviewStatusFilter.addEventListener("change", syncFilters);

  document.querySelector("#exportBtn").addEventListener("click", function () {
    var checklist = Store.state.samples.map(function (sample) {
      var points = Domain.pointsOfSlide(Store.state, sample.id).map(function (p) {
        return {
          矿物: p.mineral,
          片内位置: p.position,
          测量人: p.operator,
          初测均一温度: p.th,
          初测爆裂温度: p.td,
          复核状态: Domain.STATUS[p.status].text,
          复核人: p.review ? p.review.reviewer : "",
          复测均一温度: p.review ? p.review.th : "",
          复测爆裂温度: p.review ? p.review.td : "",
          留档条数: p.history.length
        };
      });
      return {
        样本编号: sample.code,
        采样地点: sample.location,
        放大倍数: sample.magnification,
        偏光类型: sample.polarization,
        主要矿物: sample.minerals,
        颗粒结构: sample.texture,
        老师批注: sample.comment,
        包裹体测温: points
      };
    });
    var blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "thin-section-checklist.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  render();
})();
