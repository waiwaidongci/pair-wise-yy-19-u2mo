/*
 * 页面层：只负责读取筛选条件、渲染 DOM、转发用户动作。
 * 业务判定在 domain.js，写入与留档在 store.js，本层不做规则裁决。
 */
(function () {
  "use strict";

  var D = window.ThermoDomain;
  var store = window.ThermoStore;
  var state = store.state;

  var form = document.querySelector("#sampleForm");
  var photoInput = document.querySelector("#photoInput");
  var sampleGrid = document.querySelector("#sampleGrid");
  var comparePane = document.querySelector("#comparePane");
  var mineralFilter = document.querySelector("#mineralFilter");
  var polarFilter = document.querySelector("#polarFilter");
  var statusFilter = document.querySelector("#statusFilter");
  var pointForm = document.querySelector("#pointForm");
  var pointFormMsg = document.querySelector("#pointFormMsg");
  var pointSampleSelect = document.querySelector("#pointSampleSelect");
  var pointList = document.querySelector("#pointList");

  var pendingPhoto = "";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function temp(value) {
    return value === null || value === undefined || value === "" ? "—" : Number(value).toFixed(1) + "℃";
  }

  function time(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { hour12: false });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve("");
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.readAsDataURL(file);
    });
  }

  function sampleById(id) {
    return state.samples.find((sample) => sample.id === id);
  }

  function sampleByPoint(point) {
    return sampleById(point.sampleId);
  }

  /* ---------- 筛选：薄片与测点共用矿物关键字，状态筛选只作用于测点 ---------- */

  function filteredSamples() {
    const mineral = mineralFilter.value.trim();
    const polarization = polarFilter.value;
    return state.samples.filter((sample) => {
      const mineralMatch = !mineral || (sample.minerals || "").includes(mineral);
      const polarMatch = !polarization || sample.polarization === polarization;
      return mineralMatch && polarMatch;
    });
  }

  function filteredPoints() {
    const mineral = mineralFilter.value.trim();
    const status = statusFilter.value;
    return store.orderedPoints().filter((point) => {
      const visibleSample = filteredSamples().some((sample) => sample.id === point.sampleId);
      // 偏光筛选不属于测点维度：只要薄片可见即可；矿物关键字同时匹配测点矿物
      const mineralMatch = !mineral || point.mineral.includes(mineral) ||
        ((sampleByPoint(point) || {}).minerals || "").includes(mineral);
      const statusMatch = !status || point.status === status;
      return visibleSample && mineralMatch && statusMatch;
    });
  }

  /* ---------- 页面：样本卡片 ---------- */

  function renderSamples() {
    const rows = filteredSamples();
    sampleGrid.innerHTML = rows.length ? rows.map((sample) => {
      const total = store.pointsForSample(sample.id).length;
      const pending = store.pointsForSample(sample.id).filter((p) => p.status === "pending").length;
      return `
      <article class="sample-card">
        ${sample.photo ? `<img src="${sample.photo}" alt="${esc(sample.code)}显微照片">` : '<div class="photo-placeholder"></div>'}
        <div class="sample-body">
          <h3>${esc(sample.code)}</h3>
          <p>${esc(sample.location || "未记录地点")} · ${esc(sample.magnification || "未记录倍数")} · ${esc(sample.polarization)}</p>
          <p>矿物：${esc(sample.minerals || "未记录")}</p>
          <p>结构：${esc(sample.texture || "未记录")}</p>
          <p>${esc(sample.comment || "未填写批注")}</p>
          <p class="point-count">测温点 ${total} · 待复核 ${pending}</p>
          <div class="card-actions">
            <label><input type="checkbox" data-compare="${sample.id}" ${store.isComparing("sample", sample.id) ? "checked" : ""}>对比</label>
            <button type="button" data-delete="${sample.id}">删除</button>
          </div>
        </div>
      </article>`;
    }).join("") : "<p>还没有样本，先从左侧录入一张薄片照片。</p>";
  }

  /* ---------- 页面：测点下拉选项（刷新/筛选后保持选中薄片一致） ---------- */

  function renderPointSampleOptions() {
    const previous = pointSampleSelect.value;
    pointSampleSelect.innerHTML = state.samples.length
      ? '<option value="">选择薄片…</option>' + state.samples.map((s) =>
          `<option value="${s.id}">${esc(s.code)}${s.location ? " · " + esc(s.location) : ""}</option>`).join("")
      : '<option value="">请先录入薄片</option>';
    if (previous && state.samples.some((s) => s.id === previous)) {
      pointSampleSelect.value = previous;
    }
  }

  /* ---------- 页面：留档条目 ---------- */

  function historyLine(entry) {
    if (entry.type === "create") {
      return `初测建档：均一 ${temp(entry.th)} / 爆裂 ${temp(entry.td)}（${esc(entry.by || "未署名")}）`;
    }
    if (entry.type === "review-approved") {
      return `复核通过：均一 ${temp(entry.th)} / 爆裂 ${temp(entry.td)}，Δ均一 ${entry.deltaTh.toFixed(1)}℃、Δ爆裂 ${entry.deltaTd.toFixed(1)}℃（${esc(entry.by)}）`;
    }
    if (entry.type === "review-returned") {
      return `复核退回返测：均一 ${temp(entry.th)} / 爆裂 ${temp(entry.td)}，Δ均一 ${entry.deltaTh.toFixed(1)}℃、Δ爆裂 ${entry.deltaTd.toFixed(1)}℃（${esc(entry.by)}）`;
    }
    if (entry.type === "correct") {
      const oldReview = entry.old.review ? `，旧复核 ${temp(entry.old.review.th)} / ${temp(entry.old.review.td)}（${esc(entry.old.review.reviewer)}）作废` : "";
      return `更正重排：${esc(entry.old.mineral)} / ${esc(entry.old.position)} · ${temp(entry.old.th)} / ${temp(entry.old.td)}
        → ${esc(entry.next.mineral)} / ${esc(entry.next.position)} · ${temp(entry.next.th)} / ${temp(entry.next.td)}${oldReview}（${esc(entry.by || "未署名")}）`;
    }
    return esc(entry.type);
  }

  /* ---------- 页面：单个测点（唯一一条待复核记录在这里展开） ---------- */

  function pointTemplate(point) {
    const sample = sampleByPoint(point);
    const code = sample ? sample.code : "（薄片已删除）";
    const statusClass = "st-" + point.status;
    const checked = store.isComparing("point", point.id) ? "checked" : "";

    let statusPanel = "";
    if (point.status === "pending") {
      statusPanel = `
        <div class="point-panel" data-role="review">
          <div class="pair">
            <label>复核人（须与初测人不同）<input class="rv-reviewer" placeholder="换人复核"></label>
          </div>
          <div class="pair">
            <label>复核均一温度 ℃<input class="rv-th" type="number" step="0.1"></label>
            <label>复核爆裂温度 ℃<input class="rv-td" type="number" step="0.1"></label>
          </div>
          <div class="row-actions">
            <button type="button" data-review-submit="${point.id}">提交复核</button>
          </div>
          <p class="form-msg" data-role="msg" hidden></p>
        </div>`;
    } else if (point.status === "approved") {
      const r = point.review;
      statusPanel = `
        <div class="point-panel is-approved">
          <p>复核人：${esc(r.reviewer)} · ${time(r.at)}</p>
          <p>复核 均一 ${temp(r.th)} / 爆裂 ${temp(r.td)}；两次温差 Δ均一 ${r.deltaTh.toFixed(1)}℃、Δ爆裂 ${r.deltaTd.toFixed(1)}℃，未超过 ${D.TOLERANCE}℃。</p>
        </div>`;
    } else {
      const r = point.review;
      statusPanel = `
        <div class="point-panel is-returned">
          <p>复核人：${esc(r.reviewer)} · ${time(r.at)}</p>
          <p>复核 均一 ${temp(r.th)} / 爆裂 ${temp(r.td)}；Δ均一 ${r.deltaTh.toFixed(1)}℃、Δ爆裂 ${r.deltaTd.toFixed(1)}℃，温差超过 ${D.TOLERANCE}℃，已退回返测。请更正温度后重新进入待复核。</p>
        </div>`;
    }

    const historyItems = point.history.slice().reverse().map((entry) => `
      <li>
        <time>${time(entry.at)}</time>
        <span>${historyLine(entry)}</span>
      </li>`).join("");

    return `
      <article class="point-item ${statusClass}" data-point-id="${point.id}">
        <div class="point-line">
          <div>
            <strong>${esc(point.mineral)}</strong> · ${esc(point.position)}
            <span class="point-sample">${esc(code)}</span>
          </div>
          <span class="badge ${statusClass}">${D.STATUS[point.status]}</span>
        </div>
        <p class="point-temps">初测 均一 ${temp(point.th)} / 爆裂 ${temp(point.td)}<span>（初测人 ${esc(point.observer || "未署名")}）</span></p>

        ${statusPanel}

        <div class="point-panel" data-role="correct" hidden>
          <div class="pair">
            <label>矿物<input class="ct-mineral" value="${esc(point.mineral)}"></label>
            <label>测点位置<input class="ct-position" value="${esc(point.position)}"></label>
          </div>
          <div class="pair">
            <label>均一温度 ℃<input class="ct-th" type="number" step="0.1" value="${point.th}"></label>
            <label>爆裂温度 ℃<input class="ct-td" type="number" step="0.1" value="${point.td}"></label>
          </div>
          <div class="row-actions">
            <button type="button" data-correct-save="${point.id}">按新值重排并留档</button>
            <button type="button" class="ghost" data-toggle="correct">取消</button>
          </div>
          <p class="form-msg" data-role="msg" hidden></p>
        </div>

        <div class="point-panel point-history" data-role="history" hidden>
          <ol>${historyItems}</ol>
        </div>

        <div class="point-actions">
          <label class="inline-check"><input type="checkbox" data-compare-point="${point.id}" ${checked}>对照</label>
          <button type="button" class="ghost" data-toggle="correct">更正</button>
          <button type="button" class="ghost" data-toggle="history">留档</button>
          <button type="button" class="danger" data-point-delete="${point.id}">删除</button>
        </div>
      </article>`;
  }

  function renderPoints() {
    const rows = filteredPoints();
    pointList.innerHTML = rows.length
      ? rows.map(pointTemplate).join("")
      : "<p>没有符合筛选的测温点。新增测点需先选择薄片，矿物、位置、均一温度、爆裂温度齐全且爆裂温度高于均一温度。</p>";
  }

  /* ---------- 页面：并排对照（样本与测点混排，刷新后状态一致） ---------- */

  function renderCompare() {
    const entries = store.compareEntries().slice(0, 2);
    comparePane.innerHTML = entries.length ? entries.map((entry) => {
      if (entry.kind === "point") {
        const point = entry.point;
        const sample = sampleByPoint(point);
        const review = point.review
          ? `<p>复核 ${temp(point.review.th)} / ${temp(point.review.td)}（${esc(point.review.reviewer)}）<br>Δ均一 ${point.review.deltaTh.toFixed(1)}℃ · Δ爆裂 ${point.review.deltaTd.toFixed(1)}℃</p>`
          : "<p>尚未复核</p>";
        return `
          <article class="compare-item compare-point">
            <h3>${esc(sample ? sample.code : "薄片已删")} · ${esc(point.mineral)}</h3>
            <p>${esc(point.position)} · <span class="badge st-${point.status}">${D.STATUS[point.status]}</span></p>
            <p>初测 ${temp(point.th)} / ${temp(point.td)}</p>
            ${review}
          </article>`;
      }
      const sample = entry.sample;
      return `
        <article class="compare-item">
          ${sample.photo ? `<img src="${sample.photo}" alt="${esc(sample.code)}对比图">` : ""}
          <h3>${esc(sample.code)}</h3>
          <p>${esc(sample.polarization)} · ${esc(sample.minerals || "未记录矿物")}</p>
          <p>${esc(sample.texture || "未记录结构")}</p>
        </article>`;
    }).join("") : "<p>勾选两张样本或测温点后可并排对照；测点被退回或更正时其旧对照自动失效。</p>";
  }

  function render() {
    renderPointSampleOptions();
    renderSamples();
    renderPoints();
    renderCompare();
  }

  function panelMsg(article, role, text) {
    const panel = article.querySelector('[data-role="' + role + '"]');
    const msg = panel && panel.querySelector('[data-role="msg"]');
    if (!msg) return;
    msg.textContent = text;
    msg.hidden = !text;
  }

  /* ---------- 事件：样本 ---------- */

  photoInput.addEventListener("change", async () => {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    if (!pendingPhoto && photoInput.files[0]) {
      pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
    }
    store.addSample({
      id: crypto.randomUUID(),
      photo: pendingPhoto,
      code: data.get("code").trim(),
      location: data.get("location").trim(),
      magnification: data.get("magnification").trim(),
      polarization: data.get("polarization"),
      minerals: data.get("minerals").trim(),
      texture: data.get("texture").trim(),
      comment: data.get("comment").trim(),
      createdAt: new Date().toISOString()
    });
    pendingPhoto = "";
    photoInput.value = "";
    form.reset();
    render();
  });

  sampleGrid.addEventListener("click", (event) => {
    const deleteId = event.target.dataset.delete;
    if (deleteId) {
      store.removeSample(deleteId);
      render();
    }
  });

  sampleGrid.addEventListener("change", (event) => {
    const id = event.target.dataset.compare;
    if (!id) return;
    store.toggleCompare("sample", id);
    render();
  });

  /* ---------- 事件：测点新增 ---------- */

  pointForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(pointForm);
    const result = store.addPoint({
      sampleId: data.get("sampleId"),
      mineral: data.get("mineral"),
      position: data.get("position"),
      th: data.get("th"),
      td: data.get("td"),
      observer: data.get("observer")
    });
    if (!result.ok) {
      // 缺项或爆裂不高于均一：整条拒绝，不写入，表单值保留供更正
      pointFormMsg.textContent = "已拒绝，未写入：" + result.errors.join("；");
      pointFormMsg.hidden = false;
      return;
    }
    pointForm.reset();
    pointFormMsg.hidden = true;
    render();
  });

  /* ---------- 事件：测点行内复核 / 更正 / 留档 / 对照 ---------- */

  pointList.addEventListener("click", (event) => {
    const toggleRole = event.target.dataset.toggle;
    const article = event.target.closest(".point-item");
    if (article && toggleRole) {
      const panel = article.querySelector('[data-role="' + toggleRole + '"]');
      if (panel) panel.hidden = !panel.hidden;
      return;
    }

    if (!article) return;
    const pointId = article.dataset.pointId;

    if (event.target.dataset.pointDelete) {
      store.removePoint(pointId);
      render();
      return;
    }

    if (event.target.dataset.reviewSubmit !== undefined) {
      const result = store.submitReview(pointId, {
        reviewer: article.querySelector(".rv-reviewer").value,
        th: article.querySelector(".rv-th").value,
        td: article.querySelector(".rv-td").value
      });
      if (!result.ok) {
        panelMsg(article, "review", "已拒绝，未写入：" + result.errors.join("；"));
        return;
      }
      render();
      return;
    }

    if (event.target.dataset.correctSave !== undefined) {
      const result = store.correctPoint(pointId, {
        mineral: article.querySelector(".ct-mineral").value,
        position: article.querySelector(".ct-position").value,
        th: article.querySelector(".ct-th").value,
        td: article.querySelector(".ct-td").value
      });
      if (!result.ok) {
        panelMsg(article, "correct", "已拒绝，未写入：" + result.errors.join("；"));
        return;
      }
      render();
    }
  });

  pointList.addEventListener("change", (event) => {
    const id = event.target.dataset.comparePoint;
    if (!id) return;
    store.toggleCompare("point", id);
    render();
  });

  [mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", render));
  statusFilter.addEventListener("change", render);

  /* ---------- 导出：含测温点与完整留档 ---------- */

  document.querySelector("#exportBtn").addEventListener("click", () => {
    const checklist = state.samples.map((sample) => ({
      样本编号: sample.code,
      采样地点: sample.location,
      放大倍数: sample.magnification,
      偏光类型: sample.polarization,
      主要矿物: sample.minerals,
      颗粒结构: sample.texture,
      老师批注: sample.comment,
      包裹体测温点: store.pointsForSample(sample.id).map((point) => ({
        矿物: point.mineral,
        测点位置: point.position,
        初测人: point.observer,
        均一温度: point.th,
        爆裂温度: point.td,
        状态: D.STATUS[point.status],
        复核: point.review ? {
          复核人: point.review.reviewer,
          均一温度: point.review.th,
          爆裂温度: point.review.td,
          温差_均一: point.review.deltaTh,
          温差_爆裂: point.review.deltaTd,
          时间: point.review.at
        } : null,
        留档: point.history
      }))
    }));
    const blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "thin-section-checklist.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  render();
})();
