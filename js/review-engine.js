/* uppr review engine — JS port of Reviews::WorkoutSplitParser + ExerciseMatcher + SplitReviewer.
 * Self-contained. Loads catalog/aliases/landmarks JSON on init.
 * Public API: window.UpprReview.init() then UpprReview.analyse(text).
 * Parity is validated by the shared fixture (spec/fixtures/review_cases.json) — when in doubt, the Ruby version is the reference.
 */
(function (root) {
  "use strict";

  let CAT = null;          // [{name, primary, secondary[], aliases[]}]
  let ALIASES = null;      // { lowercase phrase: "Display Name", ... }
  let LANDMARKS = null;    // { muscle: {mv: [lo,hi], mev: [..], mav: [..], mrv: [..]} }
  let NAME_INDEX = null;   // built at init: lowercase-name → catalog entry
  let MUSCLE_GROUPS = null;

  // ─── INIT ──────────────────────────────────────────────────────────────────
  async function init(basePath) {
    const base = basePath || "data";
    const [c, a, l] = await Promise.all([
      fetch(base + "/catalog.json").then(r => r.json()),
      fetch(base + "/aliases.json").then(r => r.json()),
      fetch(base + "/landmarks.json").then(r => r.json())
    ]);
    CAT = c; ALIASES = a; LANDMARKS = l;
    NAME_INDEX = {};
    for (const e of CAT) NAME_INDEX[e.name.toLowerCase()] = e;
    MUSCLE_GROUPS = Object.keys(LANDMARKS);
  }

  // ─── LINE PARSING ──────────────────────────────────────────────────────────
  const RE = {
    bullet: /^[\s*\-•]+/,
    weight: /\(?\s*(?:bw\s*\+\s*|bodyweight\s*\+\s*|with\s+|w\/\s*)?@?\s*\d+(?:\.\d+)?\s*(?:kg|kgs|lbs|lb|pounds|kilos)\b\)?/gi,
    digitLetter: /(\d)([a-z])/gi,
    sep: "(?:[x×]|times|by)",
    rpe: /(?:@\s*RPE\s*|\bRPE\s*)(\d+(?:\.\d+)?)/i,
    rpeShort: /@\s*(\d+(?:\.\d+)?)\b/,
    rir: /\bRIR\s*(\d+)/i,
    failure: /\bto failure\b/i,
    amrap: /\bAMRAP\b/i,
    fiveThreeOne: /\b5\/3\/1\b/,
    trailTail: /\b(reps?|sets?|each\s+side|each\s+leg|e\/s|per\s+side|per\s+leg|machine|cable|bb|db)\s*$/i,
    parenTail: /\s*\([^)]*\)\s*$/,
    withTail: /\s+with\s+\S[\w\s\-]*$/i,
    trailPunct: /[:,]+\s*$/
  };
  const PROSE_STOPWORDS = ["week","split","thoughts","routine","program","day","feedback"];
  const LONE_X_MAX = 35;

  function parseLine(line) {
    let t = String(line || "").replace(RE.bullet, "");
    // Em dash is used by users as a separator between exercise name and set
    // spec ("Bench Press — 3x8"). It's never part of an exercise name. Strip
    // it early so trailing "Bench Press —" doesn't defeat alias lookup.
    // (Hyphen and en dash are kept — the rep-range regex uses en dash.)
    t = t.replace(/—/g, " ");
    t = t.replace(RE.weight, " ").replace(/\s+/g, " ");
    t = t.replace(RE.digitLetter, "$1 $2");
    let intensity = null, rpe = null, rir = null;
    let sets = null, repLow = null, repHigh = null;

    if (RE.fiveThreeOne.test(t)) { intensity = "strength_template_531"; t = t.replace(RE.fiveThreeOne, ""); }
    let m;
    if ((m = t.match(RE.rpe))) { rpe = parseFloat(m[1]); t = t.replace(m[0], ""); }
    else if ((m = t.match(RE.rpeShort))) { rpe = parseFloat(m[1]); t = t.replace(m[0], ""); }
    if ((m = t.match(RE.rir))) { rir = parseInt(m[1], 10); t = t.replace(m[0], ""); }
    if (RE.failure.test(t)) { intensity = "to_failure"; t = t.replace(RE.failure, ""); }

    const s = RE.sep;
    const tryMatch = (re, fn) => { const mm = t.match(re); if (mm) { fn(mm); t = t.replace(mm[0], ""); return true; } return false; };

    tryMatch(/\b(\d+)\s*[x×]\s*(\d+)\s*(?:s|sec|secs|seconds|m|min|mins|minutes)\b/i,
      mm => { sets = +mm[1]; repLow = 1; repHigh = 1; intensity = "time_based"; }) ||
    tryMatch(new RegExp(`\\b(\\d+)\\s*${s}\\s*AMRAP\\b`, "i"),
      mm => { sets = +mm[1]; intensity = "amrap"; }) ||
    tryMatch(new RegExp(`\\b(\\d+)\\s*${s}\\s*(\\d+)\\s*[-–]\\s*(\\d+)\\b`, "i"),
      mm => { sets = +mm[1]; repLow = +mm[2]; repHigh = +mm[3]; }) ||
    tryMatch(/\b(\d+)\s*sets?\s*(?:of|x|by|times)\s*(\d+)\s*[-–]\s*(\d+)\b/i,
      mm => { sets = +mm[1]; repLow = +mm[2]; repHigh = +mm[3]; }) ||
    tryMatch(/\b(\d+)\s*sets?\s*(?:of|x|by|times)\s*(\d+)\b/i,
      mm => { sets = +mm[1]; repLow = +mm[2]; repHigh = +mm[2]; }) ||
    tryMatch(new RegExp(`\\b(\\d+)\\s*${s}\\s*(\\d+)\\b`, "i"),
      mm => {
        const a = +mm[1], b = +mm[2];
        if (a > 20 && b <= 20) { sets = 1; repLow = b; repHigh = b; }
        else { sets = a; repLow = b; repHigh = b; }
      }) ||
    tryMatch(new RegExp(`(?:^|\\s)(?:[x×]|times|by)\\s*(\\d+)\\b`, "i"),
      mm => { sets = +mm[1]; });

    let candidate = t.replace(RE.trailPunct, "").replace(/\s+/g, " ").trim();
    candidate = candidate.replace(RE.parenTail, "").trim();
    candidate = candidate.replace(RE.withTail, "").trim();
    // Loop trailing tail-word strip
    while (true) {
      const shrunk = candidate.replace(RE.trailTail, "").trim();
      if (shrunk === candidate) break;
      candidate = shrunk;
    }
    return { candidate, sets, repLow, repHigh, rpe, rir, intensity };
  }

  // ─── DAY DETECTION + LINE EXPANSION ────────────────────────────────────────
  const DAY_HEADERS = ["push","pull","legs","upper","lower","chest","back","shoulders","arms","biceps","triceps","quads","hamstrings","glutes","calves","abs","monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const DAY_HEADER_RE = new RegExp(`^\\s*(?:${DAY_HEADERS.join("|")}|full\\s+body)(?:[\\s+\\/&,]+(?:${DAY_HEADERS.join("|")}))*(?:\\s+(?:day|workout|\\d+|[a-z]))?\\s*:?\\s*$`, "i");
  const EXPLICIT_HEADER_RE = /^\s*(?:day\s+\w+|workout\s+\w+|session\s+\w+)\s*:?\s*$/i;
  function isHeader(text) {
    const t = String(text || "").trim();
    return !!t && (EXPLICIT_HEADER_RE.test(t) || DAY_HEADER_RE.test(t));
  }

  function splitSegments(text) {
    const useHyphen = !/[,;\/]/.test(text) && (text.match(/ -/g) || []).length >= 2;
    const parts = text.split(useHyphen ? / -/ : /[,;\/]/).map(s => s.trim()).filter(Boolean);
    const merged = [];
    for (const p of parts) {
      if (merged.length && /^\d/.test(p)) merged[merged.length - 1] += ", " + p;
      else merged.push(p);
    }
    return merged;
  }

  function expandLines(raw) {
    const out = [];
    for (const line0 of String(raw || "").split(/\r?\n/)) {
      let line = line0.trim().replace(/^[\s*\-•]+/, "");
      if (!line) continue;
      // "Monday - Squat 5x5"
      let m = line.match(/^([A-Za-z]+(?:\s+\d+)?)\s+[-–]\s+(.+)$/);
      if (m && isHeader(m[1] + ":")) { out.push(m[1].trim() + ":"); out.push(m[2].trim()); continue; }
      m = line.match(/^([^:]+):\s*(.+)$/);
      if (m && isHeader(m[1] + ":")) { out.push(m[1].trim() + ":"); out.push(...splitSegments(m[2])); continue; }
      if (/[,;\/]/.test(line)) { out.push(...splitSegments(line)); continue; }
      out.push(line);
    }
    return out;
  }

  function isProseDrop(p) {
    if (p.sets == null) return false;
    if (p.repLow != null) return false;
    const c = (p.candidate || "").toLowerCase();
    if (c.length > LONE_X_MAX) return true;
    return PROSE_STOPWORDS.some(w => c.indexOf(w) >= 0);
  }

  // ─── NAME RESOLUTION ───────────────────────────────────────────────────────
  // Port of ExerciseMatcher: aliases → exact → normalised → ILIKE → trigram fuzzy.
  function normName(s) {
    return String(s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  }
  function canonicalForm(name) {
    return String(name || "").toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  }
  function preStrip(s) {
    return String(s || "").toLowerCase()
      .replace(/\bover\s+head\b/g, "overhead")
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s+with\s+\S[\w\s\-]*$/i, "")
      .replace(/\s+/g, " ").trim();
  }
  function trigrams(s) {
    const t = "  " + s + " "; const out = [];
    for (let i = 0; i <= t.length - 3; i++) out.push(t.substring(i, i + 3));
    return out;
  }
  function trigramSim(a, b) {
    const A = trigrams(a.toLowerCase()), B = trigrams(b.toLowerCase());
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    let inter = 0; for (const g of A) if (setB.has(g)) inter++;
    const union = new Set([...A, ...B]).size;
    return Math.round((inter / union) * 100);
  }

  function resolve(rawName) {
    const cleaned = preStrip(rawName);
    if (!cleaned) return { canonical: null, confidence: 0 };
    const normed = normName(cleaned);
    // 1. Alias hit
    if (ALIASES[normed]) {
      const entry = NAME_INDEX[ALIASES[normed].toLowerCase()];
      if (entry) return { canonical: canonicalForm(entry.name), confidence: 0.95, exercise: entry };
    }
    // 2. Exact catalog name
    if (NAME_INDEX[cleaned]) {
      const e = NAME_INDEX[cleaned];
      return { canonical: canonicalForm(e.name), confidence: 1.0, exercise: e };
    }
    // 3. Normalised exact (catalog name normalised)
    for (const e of CAT) {
      if (normName(e.name) === normed) return { canonical: canonicalForm(e.name), confidence: 0.9, exercise: e };
    }
    // 4. Substring ILIKE-ish
    const cLower = cleaned;
    for (const e of CAT) {
      if (e.name.toLowerCase().indexOf(cLower) >= 0) {
        return { canonical: canonicalForm(e.name), confidence: trigramSim(cLower, e.name) / 100, exercise: e };
      }
    }
    // 5. Trigram fuzzy
    let best = null, bestScore = 0;
    for (const e of CAT) {
      const s = trigramSim(cLower, e.name);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (best && bestScore >= 40) return { canonical: canonicalForm(best.name), confidence: bestScore / 100, exercise: best };
    return { canonical: null, confidence: 0 };
  }

  // ─── MUSCLE MAPPING ────────────────────────────────────────────────────────
  // Translate catalog muscle vocab → review's vocab (volume landmarks use the coarser groups).
  const GROUP_TR = {
    lats: "back", upper_back: "back", traps: "back",
    front_delts: "shoulders", side_delts: "shoulders", rear_delts: "shoulders",
    obliques: "abs", forearms: "biceps", cardio: null
  };
  function muscleFor(canonicalLower) {
    // Find catalog entry by canonical form
    for (const e of CAT) {
      if (canonicalForm(e.name) === canonicalLower) {
        const raw = (e.primary || "").toLowerCase();
        return Object.prototype.hasOwnProperty.call(GROUP_TR, raw) ? GROUP_TR[raw] : raw;
      }
    }
    return null;
  }

  // Indirect-credit table: same as Ruby Reviews::MuscleMap::INDIRECT for the common compounds.
  const INDIRECT = {
    "barbell bench press": { triceps: 0.4, shoulders: 0.25 },
    "barbell incline bench press": { triceps: 0.4, shoulders: 0.3 },
    "dumbbell bench press": { triceps: 0.4, shoulders: 0.25 },
    "dumbbell incline press": { triceps: 0.4, shoulders: 0.3 },
    "machine chest press": { triceps: 0.35, shoulders: 0.2 },
    "overhead press": { triceps: 0.35 },
    "dumbbell shoulder press": { triceps: 0.3 },
    "weighted dip": { triceps: 0.5, chest: 0.4 },
    "barbell row": { biceps: 0.35, back: 0 },
    "pendlay row": { biceps: 0.35 },
    "cable seated row": { biceps: 0.3 },
    "seated cable row": { biceps: 0.3 },
    "machine row": { biceps: 0.3 },
    "t-bar row": { biceps: 0.35 },
    "lat pulldown": { biceps: 0.3 },
    "pull-up": { biceps: 0.4 },
    "chin-up": { biceps: 0.5 },
    "barbell back squat": { glutes: 0.5, hamstrings: 0.25 },
    "barbell front squat": { glutes: 0.4, hamstrings: 0.2 },
    "hack squat": { glutes: 0.4, hamstrings: 0.2 },
    "leg press": { glutes: 0.35, hamstrings: 0.2 },
    "barbell deadlift": { glutes: 0.5, hamstrings: 0.6, back: 0.3 },
    "conventional deadlift": { glutes: 0.5, hamstrings: 0.6, back: 0.3 },
    "romanian deadlift": { glutes: 0.6, back: 0.2 },
    "trap bar deadlift": { glutes: 0.5, hamstrings: 0.5, back: 0.3 }
  };

  // ─── ANALYSIS PIPELINE ─────────────────────────────────────────────────────
  function analyse(rawText) {
    const lines = expandLines(rawText);
    const days = [];
    let currentDay = null;
    let unmatched = [];

    for (const ln of lines) {
      if (isHeader(ln)) {
        if (currentDay) days.push(currentDay);
        currentDay = { label: ln.replace(/:\s*$/, "").trim(), exercises: [] };
        continue;
      }
      const p = parseLine(ln);
      if (!p.candidate && p.sets == null) continue;
      if (!p.candidate && p.sets != null) continue; // bare set/rep
      if (isProseDrop(p)) continue;
      const r = resolve(p.candidate);
      if (!r.canonical && p.sets == null) continue;
      if (!currentDay) currentDay = { label: "Day 1", exercises: [] };
      const ex = { rawName: p.candidate, canonical: r.canonical, confidence: r.confidence, sets: p.sets, repLow: p.repLow, repHigh: p.repHigh, rpe: p.rpe, rir: p.rir, intensity: p.intensity, exercise: r.exercise };
      currentDay.exercises.push(ex);
      if (!r.canonical) unmatched.push(p.candidate);
    }
    if (currentDay) days.push(currentDay);
    // Empty days (e.g. "Monday:" followed only by sub-headers like "back bicep tricep")
    // shouldn't show up — drop them.
    const filteredDays = days.filter(d => d.exercises.length > 0);
    days.length = 0; days.push(...filteredDays);

    // Backfill missing sets so volume calc has data
    for (const d of days) for (const ex of d.exercises) {
      if (ex.canonical && ex.sets == null) { ex.sets = 3; ex.repLow = 8; ex.repHigh = 12; }
    }

    // Stats for integrity gate
    const allEx = days.flatMap(d => d.exercises);
    const total = allEx.length;
    const resolved = allEx.filter(e => e.canonical).length;
    const matchRate = total ? resolved / total : 0;
    if (matchRate < 0.9 && total > 0) {
      return { ok: false, reason: "low_match_rate", days, unmatched, total, resolved, matchRate };
    }

    // Muscle volumes
    const raw = {};
    for (const m of MUSCLE_GROUPS) raw[m] = { sets: 0, sessions: new Set() };
    days.forEach((d, idx) => {
      for (const ex of d.exercises) {
        if (!ex.canonical || ex.sets == null) continue;
        const primary = muscleFor(ex.canonical);
        if (primary && raw[primary]) {
          raw[primary].sets += ex.sets;
          raw[primary].sessions.add(idx);
        }
        const ind = INDIRECT[ex.canonical] || {};
        for (const muscle of Object.keys(ind)) {
          const f = ind[muscle];
          if (!raw[muscle]) continue;
          raw[muscle].sets += ex.sets * f;
          raw[muscle].sessions.add(idx);
        }
      }
    });
    const muscleVolumes = {};
    for (const m of MUSCLE_GROUPS) {
      const v = raw[m];
      const sets = Math.round(v.sets);
      const sessions = v.sessions.size;
      const lm = LANDMARKS[m];
      const [score, status] = scoreMuscleVolume(sets, lm);
      muscleVolumes[m] = { sets, sessions, score, status };
    }

    // Sub-scores
    const volScore = avg(Object.values(muscleVolumes).map(v => v.score).filter(s => s != null));
    const freqScore = avg(Object.values(muscleVolumes).filter(v => v.sets > 0).map(v => v.sessions === 0 ? 0 : v.sessions === 1 ? 60 : 100));
    const balScore = balanceScore(muscleVolumes);
    const movScore = movementCoverageScore(days);

    const planType = days.length <= 1 ? "single_session" : days.length === 2 ? "partial_week" : "full_program";
    const weights = {
      single_session: { volume_distribution: 0.20, frequency: 0, antagonist_balance: 0.30, movement_coverage: 0.50 },
      partial_week:   { volume_distribution: 0.30, frequency: 0.15, antagonist_balance: 0.25, movement_coverage: 0.30 },
      full_program:   { volume_distribution: 0.35, frequency: 0.25, antagonist_balance: 0.20, movement_coverage: 0.20 }
    }[planType];
    const subScores = { volume_distribution: volScore, frequency: freqScore, antagonist_balance: balScore, movement_coverage: movScore };
    const overall = Math.round(Object.keys(subScores).reduce((s, k) => s + subScores[k] * (weights[k] || 0), 0));

    // Findings
    const weakSpots = [], applause = [];
    pushVolumeFindings(muscleVolumes, weakSpots, applause);
    if (planType !== "single_session") pushFrequencyFindings(muscleVolumes, weakSpots, applause);
    pushBalanceFindings(muscleVolumes, weakSpots, applause);
    pushMovementFindings(days, weakSpots, applause);
    weakSpots.sort((a, b) => b.impact - a.impact);

    const planTypeLabel = { single_session: "Single session", partial_week: "Partial week", full_program: "Full program" }[planType];
    const planTypeDesc = {
      single_session: "You shared one session, not a full week. We're judging this as a standalone session.",
      partial_week: "You shared a couple of days. We can review what's here, but the weekly picture is partial.",
      full_program: "Three or more distinct training days — we're treating this as your weekly program."
    }[planType];

    return {
      ok: true,
      overallScore: overall,
      subScores, weights,
      planType, planTypeLabel, planTypeDescription: planTypeDesc,
      days, unmatched,
      muscleVolumes,
      weakSpots: weakSpots.map(w => w.message),
      applause
    };
  }

  function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0; }

  function scoreMuscleVolume(sets, lm) {
    if (!lm) return [null, null];
    if (sets === 0) return [0, "missing"];
    const [mvL] = lm.mv, [mevL, mevH] = lm.mev, [mavL, mavH] = lm.mav, [, mrvH] = lm.mrv;
    if (sets < mvL) return [30, "under"];
    if (sets < mevL) return [70, "maintenance"];
    if (sets <= mevH) return [90, "productive_low"];
    if (sets < mavL) return [95, "productive_low"];
    if (sets <= mavH) return [100, "optimal"];
    if (sets <= mrvH) return [85, "high"];
    return [50, "over"];
  }

  function ratioScore(actual, target, tolerance) {
    const diff = Math.abs(actual - target);
    if (diff <= tolerance) return 100;
    return Math.max(Math.round(100 - (diff - tolerance) * 80), 0);
  }

  function balanceScore(mv) {
    const push = (mv.chest?.sets || 0) + (mv.shoulders?.sets || 0) + (mv.triceps?.sets || 0);
    const pull = (mv.back?.sets || 0) + (mv.biceps?.sets || 0);
    const quad = mv.quads?.sets || 0, ham = mv.hamstrings?.sets || 0;
    const scores = [];
    if (push > 0 || pull > 0) scores.push(ratioScore(pull / Math.max(push, 1), 1.0, 0.3));
    if (quad > 0 || ham > 0) scores.push(ratioScore(ham / Math.max(quad, 1), 0.75, 0.3));
    return scores.length ? Math.round(scores.reduce((a,b)=>a+b,0) / scores.length) : 70;
  }

  const PATTERNS = {
    horizontal_push: ["barbell bench press","barbell incline bench press","barbell decline bench press","dumbbell bench press","dumbbell incline press","machine chest press","weighted dip","push-up"],
    vertical_push: ["overhead press","dumbbell shoulder press","machine shoulder press","arnold press"],
    horizontal_pull: ["barbell row","pendlay row","dumbbell row","cable seated row","seated cable row","machine row","t-bar row"],
    vertical_pull: ["lat pulldown","pull-up","chin-up"],
    squat: ["barbell back squat","barbell front squat","hack squat","leg press","bulgarian split squat","goblet squat"],
    hinge: ["barbell deadlift","conventional deadlift","sumo deadlift","trap bar deadlift","romanian deadlift","hip thrust","barbell hip thrust"]
  };
  const PATTERN_LABELS = {
    horizontal_push: "Horizontal push (bench-style)", vertical_push: "Vertical push (overhead)",
    horizontal_pull: "Horizontal pull (rows)", vertical_pull: "Vertical pull (pull-ups, pulldowns)",
    squat: "Squat / knee-dominant", hinge: "Hinge / hip-dominant"
  };
  function movementCoverageScore(days) {
    const all = days.flatMap(d => d.exercises.map(e => e.canonical).filter(Boolean));
    let present = 0; const total = Object.keys(PATTERNS).length;
    for (const k of Object.keys(PATTERNS)) if (PATTERNS[k].some(c => all.indexOf(c) >= 0)) present++;
    return Math.round((present / total) * 100);
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function pick(i, arr) { return arr[i % arr.length]; }

  function pushVolumeFindings(mv, weak, app) {
    let i = 0;
    for (const muscle of Object.keys(mv)) {
      const v = mv[muscle], lm = LANDMARKS[muscle]; if (!lm) continue;
      const tL = lm.mav[0], tH = lm.mav[1], m = cap(muscle), sets = v.sets;
      switch (v.status) {
        case "missing":
          weak.push({ impact: tL + 5, message: pick(i, [
            `No direct ${muscle} work — add 2-3 sets to start. Productive range is ${tL}-${tH}/week.`,
            `${m} is missing from the plan. Even 2 sets a week beats zero. Aim for ${tL}-${tH} eventually.`,
            `Nothing hits ${muscle} directly. Add at least one exercise targeting it.`
          ]) }); break;
        case "under": case "maintenance": {
          const gap = tL - sets;
          weak.push({ impact: gap, message: pick(i, [
            `${m}: ${sets} sets a week — about ${gap} short of the growth range (${tL}-${tH}).`,
            `${m} volume is light at ${sets}/week. Add ${gap}-ish sets to get growing.`,
            `Bump ${muscle} from ${sets} to ${tL}+ sets — that's where hypertrophy kicks in.`
          ]) }); break;
        }
        case "over": case "high": {
          const excess = sets - tH;
          if (v.status === "over") app.push(`${m}: ${sets}/week is past the point where more volume adds more growth. Try dropping ${excess} sets.`);
          break;
        }
        case "optimal":
          app.push(pick(i, [`${m} is dialled in — ${sets} sets a week is squarely in the growth zone.`, `Solid ${muscle} volume (${sets}/week). Right where it should be.`, `${m}: ${sets} sets a week — sweet spot.`])); break;
        case "productive_low":
          app.push(pick(i, [`${m} at ${sets}/week — enough to drive growth.`, `Reasonable ${muscle} volume (${sets}). Room to grow but no obvious gap.`, `${m}: ${sets} sets a week — solid stimulus.`])); break;
      }
      i++;
    }
  }
  function pushFrequencyFindings(mv, weak, app) {
    let i = 0;
    for (const muscle of Object.keys(mv)) {
      const v = mv[muscle]; if (v.sets === 0) continue;
      if (v.sessions === 1) {
        weak.push({ impact: 4, message: pick(i, [
          `${cap(muscle)} is only hit once a week. Splitting the same total volume across 2 days drives more growth.`,
          `Once a week for ${muscle} leaves growth on the table. Try spreading the sets over 2 days.`,
          `Try training ${muscle} twice a week (same total sets, half the load each day) — better stimulus, easier recovery.`
        ]) });
      } else if (v.sessions >= 2) {
        app.push(`${cap(muscle)} trained ${v.sessions}× a week — good frequency for growth.`);
      }
      i++;
    }
  }
  function pushBalanceFindings(mv, weak, app) {
    const push = (mv.chest?.sets || 0) + (mv.shoulders?.sets || 0) + (mv.triceps?.sets || 0);
    const pull = (mv.back?.sets || 0) + (mv.biceps?.sets || 0);
    if (push > 0 && pull > 0) {
      const ratio = pull / push;
      if (ratio < 0.7) weak.push({ impact: Math.round((push - pull) / 2), message: `Pull volume is light vs push (${pull} pull / ${push} push). Aim for at least 1:1.` });
      else if (ratio <= 1.3) app.push(`Push and pull volumes are well balanced (${push} vs ${pull} sets).`);
    }
    const q = mv.quads?.sets || 0, h = mv.hamstrings?.sets || 0;
    if ((q > 0 || h > 0)) {
      const lr = h / Math.max(q, 1);
      if (lr < 0.4) weak.push({ impact: Math.max(2, Math.min(12, Math.round(q * 0.75 - h))), message: `Hamstring volume is low vs quads (${h} ham / ${q} quad). Add direct hamstring work.` });
      else if (lr >= 0.5 && lr <= 1.0) app.push(`Quad/ham balance looks healthy (${q} quad / ${h} ham).`);
    }
  }
  function pushMovementFindings(days, weak, app) {
    const all = days.flatMap(d => d.exercises.map(e => e.canonical).filter(Boolean));
    const missing = [];
    for (const k of Object.keys(PATTERNS)) if (!PATTERNS[k].some(c => all.indexOf(c) >= 0)) missing.push(PATTERN_LABELS[k]);
    if (missing.length) {
      const impact = 6 * missing.length;
      weak.push({ impact, message: missing.length <= 2
        ? `Missing movement pattern: ${missing.join(", ")}. Adding one covers a major gap.`
        : `Multiple movement patterns missing: ${missing.join(", ")}. The plan leans heavily on a few patterns.` });
    } else app.push("Every major movement pattern is represented (push, pull, squat, hinge, vertical and horizontal).");
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────────
  root.UpprReview = { init, analyse, _internals: { parseLine, expandLines, resolve, isHeader, splitSegments } };
})(typeof window !== "undefined" ? window : globalThis);
