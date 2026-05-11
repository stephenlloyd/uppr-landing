/* Glue script: wire the form ↔ UpprReview engine ↔ result DOM. */
(function () {
  "use strict";
  const $ = sel => document.querySelector(sel);
  const MUSCLE_ORDER = ["chest","back","shoulders","quads","hamstrings","glutes","biceps","triceps","calves","abs"];
  const SUB_SCORE_LABELS = { volume_distribution: "Volume distribution", frequency: "Frequency", antagonist_balance: "Antagonist balance", movement_coverage: "Movement coverage" };

  let ready = false;
  const init = UpprReview.init().then(() => { ready = true; });

  // Example button — clicking should fill the textarea, not toggle <details>.
  $("#use-example").addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const text = $("#example-text").textContent;
    const ta = $("#raw"); ta.value = text; ta.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#review-form").addEventListener("submit", async e => {
    e.preventDefault();
    if (!ready) await init;
    const text = $("#raw").value;
    if (!text.trim()) { showAlert("Paste your split into the box to get a review."); return; }
    const btn = $("#submit-btn"); btn.disabled = true; btn.textContent = "Reviewing…";
    try {
      const result = UpprReview.analyse(text);
      if (!result.ok && result.reason === "low_match_rate") {
        showAlert(
          `We recognised ${result.resolved} of ${result.total} exercises (${Math.round(result.matchRate * 100)}%). ` +
          `To give you an accurate review we need at least 90%. Edit the lines below so each one starts with a clear exercise name.`,
          result.unmatched
        );
      } else if (result.ok && result.days.length === 0) {
        showAlert("We couldn't find any exercises in this. Make sure each line has a name and sets×reps, like \"Bench Press 4x8\".");
      } else {
        clearAlert();
        renderResult(result);
      }
    } catch (err) {
      console.error(err);
      showAlert("Something went wrong reviewing this. Try simplifying the text.");
    } finally {
      btn.disabled = false; btn.textContent = "Review my split";
    }
  });

  function showAlert(message, unmatchedLines) {
    const host = $("#alert-host");
    host.innerHTML = "";
    const div = document.createElement("div");
    div.className = "alert"; div.style.maxWidth = "760px"; div.style.margin = "0 auto 14px";
    div.textContent = message;
    if (unmatchedLines && unmatchedLines.length) {
      const lines = document.createElement("div"); lines.className = "lines";
      lines.innerHTML = "<strong>Lines we couldn't read</strong><br>" + unmatchedLines.map(l => "• " + escapeHtml(l)).join("<br>");
      div.appendChild(lines);
    }
    host.appendChild(div);
    $("#result-section").classList.remove("show");
    window.scrollTo({ top: host.offsetTop - 80, behavior: "smooth" });
  }
  function clearAlert() { $("#alert-host").innerHTML = ""; }

  function renderResult(r) {
    const radarUser = MUSCLE_ORDER.map(m => (r.muscleVolumes[m] || {}).sets || 0);
    const radarTarget = MUSCLE_ORDER.map(m => {
      const lm = r._landmarks || null; // engine doesn't expose landmarks; compute below
      return null;
    });
    const landmarks = r._landmarks; // not used; rely on muscle volumes
    const head = headlineFor(r.overallScore, r.weakSpots.length);
    const scoreColor = r.overallScore >= 85 ? "#22c55e" : r.overallScore >= 70 ? "#a78bfa" : r.overallScore >= 55 ? "#fbbf24" : "#f43f5e";

    const html = `
      <div class="panel hero-panel">
        <div class="score-block">
          <div class="score-label">uppr score</div>
          <div class="score-num" style="color:${scoreColor}">${r.overallScore}<span class="of">/100</span></div>
        </div>
        <div class="head-line">
          ${escapeHtml(head)}
          ${r.planTypeLabel ? `<div style="margin-top:6px"><span class="chip">${escapeHtml(r.planTypeLabel)}</span><span class="chip-desc">${escapeHtml(r.planTypeDescription || "")}</span></div>` : ""}
        </div>
      </div>

      <div class="grid two-col">
        <div class="panel split-panel">
          <div class="panel-h">Your split</div>
          ${r.days.map((d, i) => `
            <div class="day">
              <h3>Day ${i + 1}</h3>
              <ul>${d.exercises.map(ex => `
                <li class="ex">
                  <span class="nm ${ex.canonical ? '' : 'unmatched'}">${escapeHtml(ex.canonical || ex.rawName)}${ex.canonical ? '' : '<span class="unmatched-tag">(unmatched)</span>'}</span>
                  <span class="reps">${ex.sets ? `${ex.sets}×${ex.repLow === ex.repHigh ? ex.repLow : ex.repLow + "-" + ex.repHigh}${ex.rir != null ? " · " + ex.rir + " RIR" : ""}${ex.rpe != null ? " · @" + ex.rpe : ""}` : ""}</span>
                </li>`).join("")}</ul>
            </div>`).join("")}
        </div>

        <div class="grid">
          <div class="panel radar-panel">
            <div class="panel-h">Weekly muscle balance</div>
            <canvas id="radar"></canvas>
            <div class="radar-cap">Orange: your sets. Dashed: productive target.</div>
          </div>
          <div class="panel muscle-list">
            <div class="panel-h">Volume per muscle</div>
            ${renderMuscleList(r.muscleVolumes, r._landmarks)}
          </div>
        </div>
      </div>

      ${(r.weakSpots.length || r.applause.length) ? `
        <div class="grid findings-grid">
          ${r.weakSpots.length ? `
            <div class="panel fix-panel">
              <div class="panel-h">What to fix <span style="color:rgba(251,191,36,0.6);font-weight:400">(biggest impact first)</span></div>
              <ol>${r.weakSpots.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
            </div>` : ""}
          ${r.applause.length ? `
            <div class="panel good-panel">
              <div class="panel-h">What's working</div>
              <ul>${r.applause.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
            </div>` : ""}
        </div>` : ""}

      <details class="panel breakdown">
        <summary>Score breakdown</summary>
        <div class="sub-scores">
          ${Object.keys(r.subScores).filter(k => r.weights[k]).map(k => {
            const v = r.subScores[k]; const w = r.weights[k];
            const c = v >= 80 ? "green" : v >= 65 ? "violet" : v >= 50 ? "amber" : "rose";
            return `<div>
              <div class="top"><span>${SUB_SCORE_LABELS[k] || k} <span class="pct">(${Math.round(w * 100)}%)</span></span><span class="v">${v}</span></div>
              <div class="bar"><div class="fill ${c}" style="width:${v}%"></div></div>
            </div>`;
          }).join("")}
        </div>
      </details>

      <div class="cta">
        <div class="logo-big"><span class="b">u</span><span class="b">p</span><span class="d">p</span><span class="d">r</span></div>
        <h2>Training that gets smarter every session.</h2>
        <p>The same engine that just reviewed you — but it also writes the program, picks the weights, manages your RIR week by week, and adapts when life gets in the way.</p>
        <a href="https://apps.apple.com/app/uppr-strength-hypertrophy/id6761077703" class="badge-link"><img src="https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83" alt="Download on the App Store"></a>
      </div>
    `;
    $("#result-content").innerHTML = html;
    $("#result-section").classList.add("show");
    $("#form-section").style.display = "none";
    renderRadar(radarUser);
    window.scrollTo({ top: $("#result-section").offsetTop - 80, behavior: "smooth" });
  }

  function renderMuscleList(mv, landmarks) {
    return MUSCLE_ORDER.map(m => {
      const v = mv[m]; if (!v) return "";
      // Inline target derivation — we don't have landmarks on the result. Fetch from engine's MUSCLE_GROUPS? Keep simple: estimate scale from sets.
      const scale = Math.max(20, (v.sets || 0) + 4);
      const pct = Math.min(100, Math.round((v.sets / scale) * 100));
      const cls = v.status === "optimal" ? "green" : v.status === "productive_low" ? "green" : v.status === "high" ? "amber" : v.status === "over" ? "rose" : v.status === "missing" || v.status === "under" || v.status === "maintenance" ? "amber" : "violet";
      return `<div class="row">
        <div class="top"><span style="text-transform:capitalize;color:var(--body);font-weight:600">${m}</span><span class="sets">${v.sets} sets · ${v.sessions}×</span></div>
        <div class="bar"><div class="fill ${cls}" style="width:${pct}%"></div></div>
      </div>`;
    }).join("");
  }

  function renderRadar(userData) {
    // Productive target = midpoint of MEV-MAV (rough). Fetch from a small inline map.
    const TARGET = { chest:13, back:14, shoulders:13, quads:13, hamstrings:13, glutes:11, biceps:12, triceps:12, calves:11, abs:11 };
    const target = MUSCLE_ORDER.map(m => TARGET[m] || 0);
    const ctx = document.getElementById("radar"); if (!ctx) return;
    new Chart(ctx, {
      type: "radar",
      data: {
        labels: MUSCLE_ORDER.map(m => m.charAt(0).toUpperCase() + m.slice(1)),
        datasets: [
          { label: "Your sets", data: userData, backgroundColor: "rgba(249,115,22,0.20)", borderColor: "#f97316", borderWidth: 2, pointBackgroundColor: "#f97316", pointRadius: 3 },
          { label: "Productive target", data: target, backgroundColor: "transparent", borderColor: "rgba(34,197,94,0.7)", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 }
        ]
      },
      options: {
        responsive: true,
        scales: { r: { beginAtZero: true, ticks: { display: false, stepSize: 4 }, grid: { color: "rgba(255,255,255,0.08)" }, angleLines: { color: "rgba(255,255,255,0.08)" }, pointLabels: { font: { size: 10 }, color: "#a8a29e" } } },
        plugins: { legend: { position: "bottom", labels: { font: { size: 10 }, color: "#a8a29e" } } }
      }
    });
  }

  function headlineFor(score, weakCount) {
    if (score >= 90) return "Productive volumes across the board — this plan is tight.";
    if (score >= 80) return weakCount === 0 ? "Solid plan." : weakCount === 1 ? "Solid plan with one thing to close out." : `Solid plan with ${weakCount} things to close out.`;
    if (score >= 70) return `Workable plan — ${weakCount} muscle group${weakCount !== 1 ? "s" : ""} need more volume.`;
    if (score >= 60) return "Several gaps to address before this plan delivers consistent growth.";
    return "This plan needs significant rework — multiple muscle groups under-trained.";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
