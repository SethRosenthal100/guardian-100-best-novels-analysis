// app.js — multi-axis, multi-mode chart + state machine.
//
// State is split into two layers:
//
//   • `view` state — the active axis, mode, and highlighted group. Changing
//     any of these requires a full chart re-render (different dots, different
//     curves, different rankings).
//
//   • `nav` state — what the user is currently looking at (overview / book /
//     voter). Changes here only update dot classes, labels, and the sidebar
//     — the underlying chart geometry doesn't move.
//
// URL hash holds nav state (e.g. `#book/34`, `#voter/sarah-moss`). View state
// lives in memory + localStorage so it survives reloads.

(async function () {
  // ---------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------
  const W = 980;
  const H = 720;
  const M = { top: 8, right: 30, bottom: 96, left: 64 };
  const MARGINAL_H = 150;
  const MAIN_TOP = M.top + MARGINAL_H;
  const MAIN_H = H - MAIN_TOP - M.bottom;

  // ---------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------
  const data = await fetch("data_extended.json").then((r) => r.json());
  const booksByKey = new Map(data.books.map((b) => [b.key, b]));
  const votersById = new Map(data.voters.map((v) => [v.id, v]));
  const axesByKey = new Map(data.axes.map((a) => [a.key, a]));

  // Update the "All N books" pill count to the actual distinct book count
  document.getElementById("mode-all-count").textContent = data.books.length.toLocaleString();

  // ---------------------------------------------------------------------
  // View state
  // ---------------------------------------------------------------------
  function loadViewState() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem("view") || "{}");
    } catch (e) { saved = {}; }
    // UI is locked to gender + F highlighted. Multi-axis architecture is
    // preserved in the data so we can re-expose it later if/when other axes
    // (region, age) deliver interesting results.
    return {
      mode: saved.mode === "all" ? "all" : "top100",
      axis: "gender",
      highlighted: "F",
    };
  }

  function saveViewState() {
    localStorage.setItem("view", JSON.stringify(view));
  }

  const view = loadViewState();

  // ---------------------------------------------------------------------
  // SVG setup (skeleton — never re-created)
  // ---------------------------------------------------------------------
  const svg = d3
    .select("#chart")
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("class", "background-hit")
    .attr("x", 0).attr("y", 0)
    .attr("width", W).attr("height", H)
    .on("click", () => setNav({ kind: "overview", id: null }));

  const gMarginal = svg.append("g").attr("class", "g-marginal");
  const gMain     = svg.append("g").attr("class", "g-main");
  const gDots     = svg.append("g").attr("class", "g-dots");
  const gLabels   = svg.append("g").attr("class", "g-labels");

  // Scales (X is fixed; Y/KDE recomputed per axis if needed)
  const x = d3.scaleLinear().domain([-3.3, 3.3]).range([M.left, W - M.right]);
  const y = d3.scaleLinear().domain([-2, 105]).range([MAIN_TOP + MAIN_H, MAIN_TOP]);

  const sizeForVotes = (v) => 6 + 1.6 * Math.sqrt(v);

  // Two deterministic PRNG values per book (different salts) so x- and
  // y-jitter look independent.
  function hashKey(key, salt) {
    let h = salt;
    for (let i = 0; i < key.length; i++) {
      h = (h * 9301 + key.charCodeAt(i) * 49297) % 233280;
    }
    return h / 233280; // 0..1
  }

  // x-jitter scales inversely with vote count: low-vote books (which all
  // cluster on a few integer subject scores) get much more horizontal
  // spread so the cluster reads as a cloud, not a single dot.
  function xJitter(key, sval, voteCount) {
    const frac = hashKey(key, 7);
    let range = 0.14;
    if (voteCount <= 1) range = 0.34;
    else if (voteCount === 2) range = 0.24;
    else if (voteCount <= 4) range = 0.18;
    if (sval <= -3) return frac * range;
    if (sval >= 3) return -frac * range;
    return (frac - 0.5) * 2 * range;
  }

  // y-jitter (in % units) only for low-vote books, where pct_F is heavily
  // quantised (0%/50%/100%) and stacks invisibly on top of itself.
  function yJitter(key, voteCount) {
    if (voteCount >= 3) return 0;
    const frac = hashKey(key, 53);
    const range = voteCount === 1 ? 2.4 : 1.4; // percentage-point spread
    return (frac - 0.5) * 2 * range;
  }

  function opacityForVotes(v) {
    if (v >= 3) return 0.92;
    if (v === 2) return 0.45;
    return 0.30;
  }

  // ---------------------------------------------------------------------
  // Helpers that look up axis / mode / group data
  // ---------------------------------------------------------------------
  const axisDef = () => axesByKey.get(view.axis);
  const groupDef = () => axisDef().groups.find((g) => g.key === view.highlighted);
  const modeData = () => data.modes[view.mode];
  const byAxis  = () => modeData().by_axis[view.axis];

  function chartableBooks() {
    const ks = new Set(modeData().chart_book_keys);
    return data.books.filter((b) => ks.has(b.key));
  }

  function pctInHighlighted(book) {
    const groups = book.pct_voters_by_group?.[view.axis] || {};
    // Option A: for the gender axis, the chart is genuinely binary F-vs-M.
    // NB voters are excluded from the denominator (they appear elsewhere in
    // the UI but don't enter the chart math). For any other axis, use the
    // full denominator as before.
    if (view.axis === "gender") {
      const f = groups.F || 0;
      const m = groups.M || 0;
      const denom = f + m;
      if (!denom) return 0;
      const num = groups[view.highlighted] || 0;
      return (num / denom) * 100;
    }
    return groups[view.highlighted] || 0;
  }

  function voterMetrics(voter) {
    return view.mode === "all" ? voter.metrics_all : voter.metrics_top100;
  }

  function voterInHighlighted(voter) {
    if (view.axis === "gender") return voter.gender === view.highlighted;
    return false;
  }

  // ---------------------------------------------------------------------
  // Chart rendering (called on every view change)
  // ---------------------------------------------------------------------
  function renderChart() {
    // Wipe layers that depend on the active view
    gMarginal.selectAll("*").remove();
    gMain.selectAll("*").remove();
    gDots.selectAll("*").remove();
    gLabels.selectAll("*").remove();

    const ax = axisDef();
    const groups = ax.groups;
    const highlighted = view.highlighted;
    const groupLabel = (key) => (groups.find((g) => g.key === key) || {}).label || key;

    // KDE curves: highlighted group + the "non-highlighted" complementary curve
    const axisData = byAxis();
    const xsArr = axisData.kde_xs;
    const yHi = axisData.kde_by_group[highlighted] || [];
    // Construct an "other groups" KDE by combining all non-highlighted groups
    // weighted by their relative ballot counts. For binary axes we have a
    // single complementary group; for multi-group axes, "other" is a useful
    // baseline. We approximate by pooling, then renormalising via KDE-shape.
    const otherSubjects = [];
    const otherGroupsKey = groups.filter((g) => g.key !== highlighted).map((g) => g.key);

    function kde(values, xs, bw = 0.55) {
      const arr = values;
      if (!arr.length) return xs.map(() => 0);
      return xs.map(
        (xv) =>
          arr.reduce(
            (s, v) =>
              s + Math.exp(-0.5 * ((xv - v) / bw) ** 2) / (bw * Math.sqrt(2 * Math.PI)),
            0
          ) / arr.length
      );
    }
    // Pull ballot subjects for the "other" pooled group
    const pickFn =
      view.mode === "all"
        ? (v) => v.ballot
        : (v) => v.ballot.filter((p) => p.rank !== null);
    data.voters.forEach((v) => {
      if (voterInHighlighted(v)) return;
      // Option A for the gender axis: only F and M voters enter the chart
      // math; NB voters' ballots aren't pooled into the "other" curve.
      if (view.axis === "gender" && v.gender !== "F" && v.gender !== "M") return;
      pickFn(v).forEach((p) => {
        const b = booksByKey.get(p.book_key);
        if (b && b.subject !== null && b.subject !== undefined) otherSubjects.push(b.subject);
      });
    });
    const yOther = kde(otherSubjects, xsArr);

    const peak = Math.max(...yHi, ...yOther, 0.001);
    const yKde = d3.scaleLinear().domain([0, peak * 1.55]).range([M.top + MARGINAL_H, M.top + 8]);

    const line = d3.line().x((_, i) => x(xsArr[i])).y((d) => yKde(d));

    // "Other" curve drawn first so the highlighted curve sits on top
    gMarginal.append("path")
      .datum(yOther)
      .attr("class", "curve-other")
      .attr("d", line);
    gMarginal.append("path")
      .datum(yHi)
      .attr("class", "curve-highlighted")
      .attr("d", line);

    // Inline curve labels
    const hiPeak = axisData.modes_by_group[highlighted] || [];
    const hiMax = hiPeak.length
      ? hiPeak.reduce((a, b) => (a.y > b.y ? a : b))
      : { x: xsArr[yHi.indexOf(Math.max(...yHi))], y: Math.max(...yHi) };
    gMarginal.append("text")
      .attr("class", "curve-label hl")
      .attr("x", x(hiMax.x))
      .attr("y", yKde(hiMax.y) - 8)
      .attr("text-anchor", "middle")
      .text(groupLabel(highlighted));

    let otherLabel;
    if (view.axis === "gender") {
      // Option A: the "other" curve here is just the opposite binary group
      // (M when F is highlighted, F when M is highlighted). NB is excluded
      // from the math entirely so the label is accurate.
      const otherKey = view.highlighted === "F" ? "M" : "F";
      otherLabel = groupLabel(otherKey);
    } else {
      otherLabel = otherGroupsKey.length === 1
        ? groupLabel(otherGroupsKey[0])
        : "other voters";
    }
    const otherPeakIdx = yOther.indexOf(Math.max(...yOther));
    gMarginal.append("text")
      .attr("class", "curve-label other")
      .attr("x", x(xsArr[otherPeakIdx]))
      .attr("y", yKde(yOther[otherPeakIdx]) - 8)
      .attr("text-anchor", "middle")
      .text(otherLabel);

    // ---- main chart reference lines & axes ----
    let poolPct = (data.pool_by_axis[view.axis] || {})[highlighted] || 0;
    // Option A: gender pool baseline excludes NB from the denominator
    if (view.axis === "gender") {
      const pool = data.pool_by_axis.gender || {};
      const fm = (pool.F || 0) + (pool.M || 0);
      if (fm > 0) {
        poolPct = ((pool[highlighted] || 0) / fm) * 100;
      }
    }

    // empty-region shading (only meaningful for the gender chart when F is highlighted)
    if (view.axis === "gender" && highlighted === "F") {
      gMain.append("rect")
        .attr("class", "empty-region")
        .attr("x", x(0.5))
        .attr("y", y(poolPct))
        .attr("width", x(3.3) - x(0.5))
        .attr("height", y(0) - y(poolPct));
      const labelLines = [
        "Hardly any books occupy this region:",
        "female-coded subjects with majority-male voters.",
        "Mansfield Park is the only exception.",
      ];
      gMain.append("text")
        .attr("class", "empty-region-label")
        .attr("x", x(2))
        .attr("y", y(15))
        .attr("text-anchor", "middle")
        .selectAll("tspan")
        .data(labelLines)
        .join("tspan")
        .attr("x", x(2))
        .attr("dy", (d, i) => (i === 0 ? 0 : 16))
        .text((d) => d);
    }

    // pool baseline
    gMain.append("line")
      .attr("class", "ref-line")
      .attr("x1", x(-3.3)).attr("x2", x(3.3))
      .attr("y1", y(poolPct)).attr("y2", y(poolPct));
    gMain.append("text")
      .attr("class", "baseline-text")
      .attr("x", x(-3.25))
      .attr("y", y(poolPct) - 5)
      .text(`voter pool baseline = ${poolPct.toFixed(0)}% ${groupLabel(highlighted)}`);

    // y-axis ticks
    [0, 25, 50, 75, 100].forEach((t) => {
      gMain.append("text")
        .attr("class", "y-tick")
        .attr("x", M.left - 8)
        .attr("y", y(t))
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "central")
        .text(`${t}%`);
    });
    const yLabel = view.axis === "gender"
      ? `% of book's F/M voters who are ${groupLabel(highlighted)}`
      : `% of book's voters who are ${groupLabel(highlighted)}`;
    gMain.append("text")
      .attr("class", "axis-sub")
      .attr("transform", `translate(${M.left - 46}, ${MAIN_TOP + MAIN_H / 2}) rotate(-90)`)
      .attr("text-anchor", "middle")
      .text(yLabel);

    // x-axis verbal labels
    const axisY = MAIN_TOP + MAIN_H + 22;
    [
      [-3, "male-coded"],
      [0, "neutral"],
      [3, "female-coded"],
    ].forEach(([xv, label]) => {
      gMain.append("text")
        .attr("class", "axis-label")
        .attr("x", x(xv)).attr("y", axisY)
        .attr("text-anchor", "middle")
        .text(label);
    });
    gMain.append("text")
      .attr("class", "axis-sub")
      .attr("x", x(0)).attr("y", axisY + 18)
      .attr("text-anchor", "middle")
      .text("(hand-coded subject-matter, range −3 to +3)");

    // ---- dots ----
    rank_to_xy = {}; // refresh map
    const chartBooks = chartableBooks();
    // sort: low-vote books drawn first (under), high-vote books on top
    chartBooks.sort((a, b) => a.vote_count - b.vote_count);
    chartBooks.forEach((b) => {
      if (b.subject === null || b.subject === undefined) return;
      const jx = xJitter(b.key, b.subject, b.vote_count);
      const jy = yJitter(b.key, b.vote_count);
      const cx = x(b.subject + jx);
      const cy = y(pctInHighlighted(b) + jy);
      const fill = colorForBookOnAxis(b);
      // Long-tail dots shrink hard; top-100 anchors stay full size.
      let r;
      if (b.vote_count === 1) r = 3.0;
      else if (b.vote_count === 2) r = 4.0;
      else r = sizeForVotes(b.vote_count);
      // Top-100 books get a thin ink border so they read as anchors above the
      // long-tail haze. Long-tail dots are stroke-less.
      const stroke = b.in_top_100 ? "var(--ink)" : "none";
      const strokeWidth = b.in_top_100 ? 1.0 : 0;
      gDots.append("circle")
        .datum(b)
        .attr("class", `dot ${b.in_top_100 ? "top100" : "near-miss"}`)
        .attr("cx", cx).attr("cy", cy)
        .attr("r", r)
        .attr("fill", fill)
        .attr("stroke", stroke)
        .attr("stroke-width", strokeWidth)
        .attr("opacity", opacityForVotes(b.vote_count))
        .style("cursor", "pointer")
        .on("click", (event, d) => {
          event.stopPropagation();
          setNav({ kind: "book", id: d.key });
        })
        .on("mouseenter", (event, d) => showTooltip(event, d))
        .on("mousemove", moveTooltip)
        .on("mouseleave", hideTooltip);
      rank_to_xy[b.key] = { cx, cy };
    });
  }

  // Color encoding for dots depends on which axis is active. For axes with
  // an author-parallel coding (gender), we color by author attribute. For
  // axes without author parallel (role), we use a neutral grey so the chart
  // doesn't mis-encode.
  function colorForBookOnAxis(book) {
    if (axisDef().author_parallel) {
      // we have author-side groups; color by author's group
      if (view.axis === "gender") {
        if (book.author_gender === "F") return "var(--red)";
        if (book.author_gender === "M") return "var(--blue)";
        return "var(--mid)";
      }
    }
    return "var(--mid)";
  }

  // ---------------------------------------------------------------------
  // Navigation state (book / voter / overview)
  // ---------------------------------------------------------------------
  let rank_to_xy = {};
  const nav = { kind: "overview", id: null };

  function setNav(next, { fromHash } = {}) {
    nav.kind = next.kind;
    nav.id = next.id;
    applyNav();
    if (!fromHash) writeHash();
  }

  function writeHash() {
    let h = "";
    if (nav.kind === "book") h = `#book/${nav.id}`;
    else if (nav.kind === "voter") h = `#voter/${nav.id}`;
    if (window.location.hash !== h) {
      history.pushState(null, "", h || window.location.pathname);
    }
  }

  function readHash() {
    const h = window.location.hash;
    if (h.startsWith("#book/")) {
      const k = decodeURIComponent(h.slice(6));
      if (booksByKey.has(k)) return { kind: "book", id: k };
    } else if (h.startsWith("#voter/")) {
      const id = h.slice(7);
      if (votersById.has(id)) return { kind: "voter", id };
    }
    return { kind: "overview", id: null };
  }

  window.addEventListener("popstate", () => setNav(readHash(), { fromHash: true }));
  window.addEventListener("hashchange", () => setNav(readHash(), { fromHash: true }));

  // ---------------------------------------------------------------------
  // applyNav — re-classes the dots, redraws labels, refreshes sidebar
  // ---------------------------------------------------------------------
  function applyNav() {
    gLabels.selectAll("*").remove();
    gDots.selectAll("circle.dot")
      .classed("dim", false)
      .classed("focus", false)
      .classed("highlight", false);

    if (nav.kind === "book") {
      const book = booksByKey.get(nav.id);
      gDots.selectAll("circle.dot")
        .classed("dim", (d) => d.key !== nav.id)
        .classed("focus", (d) => d.key === nav.id);
      if (book) drawLabels([book]);
      renderBookPanel(book);
    } else if (nav.kind === "voter") {
      const voter = votersById.get(nav.id);
      if (!voter) { setNav({ kind: "overview", id: null }); return; }
      const ballotKeys = new Set(voter.ballot.map((p) => p.book_key));
      gDots.selectAll("circle.dot")
        .classed("dim", (d) => !ballotKeys.has(d.key))
        .classed("highlight", (d) => ballotKeys.has(d.key));
      const labelBooks = voter.ballot
        .map((p) => booksByKey.get(p.book_key))
        .filter((b) => b && rank_to_xy[b.key]);
      drawLabels(labelBooks);
      renderVoterPanel(voter);
    } else {
      const seeds = SEED_LABEL_KEYS.map((k) => booksByKey.get(k)).filter(Boolean);
      drawLabels(seeds, { muted: true });
      renderOverviewPanel();
    }
  }

  const SEED_LABEL_KEYS = [
    "top-97","top-34","top-36","top-8","top-2","top-6","top-1",
    "top-3","top-27","top-28","top-68","top-15","top-56",
  ];

  // ---------------------------------------------------------------------
  // Label placement
  // ---------------------------------------------------------------------
  function drawLabels(books, { muted = false } = {}) {
    const items = [];
    books.forEach((b) => {
      const xy = rank_to_xy[b.key];
      if (!xy) return;
      const r = sizeForVotes(b.vote_count);
      const placeLeft = xy.cx > x(0.5);
      const labelX = placeLeft ? xy.cx - r - 6 : xy.cx + r + 6;
      const anchor = placeLeft ? "end" : "start";
      items.push({ book: b, cx: xy.cx, cy: xy.cy, labelX, labelY: xy.cy, anchor });
    });
    items.sort((a, b) => a.labelY - b.labelY);
    const MIN_SPACING = 15;
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      if (items[i].labelY - prev.labelY < MIN_SPACING &&
          Math.sign(items[i].labelX - prev.labelX) === 0) {
        items[i].labelY = prev.labelY + MIN_SPACING;
      }
    }
    items.forEach((it) => {
      const g = gLabels.append("g").attr("class", muted ? "label-muted" : "label-active");
      if (Math.abs(it.labelY - it.cy) > 3) {
        const r = sizeForVotes(it.book.vote_count);
        g.append("line")
          .attr("x1", it.cx + (it.anchor === "end" ? -r : r))
          .attr("y1", it.cy)
          .attr("x2", it.labelX + (it.anchor === "end" ? 4 : -4))
          .attr("y2", it.labelY)
          .attr("stroke", muted ? "var(--mid)" : "var(--ink)")
          .attr("stroke-width", 0.7)
          .attr("opacity", muted ? 0.35 : 0.45);
      }
      const text = g.append("text")
        .attr("class", "label-text")
        .attr("x", it.labelX).attr("y", it.labelY)
        .attr("text-anchor", it.anchor)
        .attr("dominant-baseline", "central")
        .text(it.book.title);
      if (!muted) {
        const bbox = text.node().getBBox();
        g.insert("rect", "text")
          .attr("class", "label-bg")
          .attr("x", bbox.x - 3).attr("y", bbox.y - 1)
          .attr("width", bbox.width + 6).attr("height", bbox.height + 2);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------
  const panel = document.getElementById("panel-content");
  let activeTab = "books";

  function activateTab(name) {
    activeTab = name;
    panel.querySelectorAll(".tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === name)
    );
    panel.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.dataset.panel !== name;
    });
  }

  function wireTabClicks() {
    panel.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function formatScore(s) {
    if (s === null || s === undefined) return "—";
    if (s === 0) return "0";
    return s > 0 ? `+${s}` : `${s}`;
  }
  function formatScoreSigned(s) {
    if (s === null || s === undefined) return "—";
    return (s > 0 ? "+" : "") + s.toFixed(2);
  }

  // marker symbol for a voter on the active axis
  function voterMarkerHtml(voter) {
    if (view.axis === "gender") {
      return `<span class="marker ${voter.gender}"></span>`;
    }
    return `<span class="marker unknown"></span>`;
  }

  // -- ranking helpers --
  function rankingItem(voter, metricLabel) {
    return `
      <li data-voter="${voter.id}">
        ${voterMarkerHtml(voter)}
        <span>${escapeHtml(voter.name)}</span>
        <span class="secondary">${metricLabel}</span>
      </li>`;
  }
  function rankingBlock(title, blurb, ids, metricFn) {
    if (!ids || !ids.length) return "";
    const items = ids.slice(0, 5)
      .map((vid) => rankingItem(votersById.get(vid), metricFn(votersById.get(vid))))
      .join("");
    return `
      <div class="ranking-block">
        <div class="ranking-title">${title}</div>
        <div class="ranking-blurb">${blurb}</div>
        <ul class="panel-list panel-list--compact">${items}</ul>
      </div>`;
  }

  function renderRankings() {
    const md = modeData();
    const indep = md.rankings_axis_independent;
    const m = (v) => voterMetrics(v);

    // axis-dependent: "against trend" rankings. For binary axes (gender)
    // we show both directions; for multi-group axes we'd show all groups.
    const trendBlocks = axisDef().groups
      .filter((g) => g.key !== "NB")  // only 2 NB voters; not enough to rank
      .map((g) => {
        const ids = byAxis().rankings_against_trend[`${g.key}_against_trend`] || [];
        return rankingBlock(
          `${g.label} going against the ${axisDef().label.toLowerCase()} pattern`,
          `Voters in this group whose ballots deviate furthest from the group mean.`,
          ids, (v) => `mean ${formatScoreSigned(m(v).mean_subject)}`
        );
      })
      .filter(Boolean)
      .join("");

    return `
      <div class="panel-section" style="margin-top: 14px">
        <div class="panel-kicker">Book-property rankings</div>
        ${rankingBlock("Narrowest tastes",
          "Lowest spread of subject scores across their picks.",
          indep.narrowest, (v) => `σ ${(m(v).std_subject ?? 0).toFixed(2)}`)}
        ${rankingBlock("Broadest tastes",
          "Highest spread — voted across the whole gradient.",
          indep.broadest, (v) => `σ ${(m(v).std_subject ?? 0).toFixed(2)}`)}
        ${rankingBlock("Most male-coded picks",
          "Lowest mean subject score in their ballot.",
          indep.most_male_coded, (v) => `mean ${formatScoreSigned(m(v).mean_subject)}`)}
        ${rankingBlock("Most female-coded picks",
          "Highest mean subject score in their ballot.",
          indep.most_female_coded, (v) => `mean ${formatScoreSigned(m(v).mean_subject)}`)}
        ${rankingBlock("Most canonical taste",
          "Picks the stuffy old venerated canon.",
          indep.most_canonical, (v) => m(v).mean_year ? `avg yr ${Math.round(m(v).mean_year)}` : "")}
        ${rankingBlock("Most idiosyncratic taste",
          "Picks recent / diverse / expanded-canon books.",
          indep.most_idiosyncratic, (v) => m(v).mean_year ? `avg yr ${Math.round(m(v).mean_year)}` : "")}
        ${rankingBlock("Most contrarian picks",
          "Lowest average vote-count among their books.",
          indep.most_contrarian, (v) => `avg ${m(v).mean_pick_popularity?.toFixed(1)} voters/book`)}
        ${rankingBlock("Most consensus picks",
          "Highest average vote-count.",
          indep.most_consensus, (v) => `avg ${m(v).mean_pick_popularity?.toFixed(1)} voters/book`)}
      </div>
      <div class="panel-section" style="margin-top: 22px">
        <div class="panel-kicker">Identity-based rankings</div>
        ${trendBlocks}
      </div>
    `;
  }

  function bookListItem(b, extraSecondary) {
    return `
      <li data-book="${b.key}">
        ${b.rank ? `<span class="rank-num">${b.rank}</span>` : `<span class="rank-num">—</span>`}
        <span class="marker ${b.author_gender}"></span>
        <span class="book-title">${escapeHtml(b.title)}</span>
        <span class="secondary">${escapeHtml(extraSecondary || b.author)}</span>
      </li>`;
  }

  function renderOverviewPanel() {
    // Top-100, in reveal order (100 → 1)
    const top100 = [...data.books]
      .filter((b) => b.in_top_100)
      .sort((a, b) => b.rank - a.rank);
    // Near-misses (3+ voters, hand-coded subject/canonicity)
    const nearMisses = data.books
      .filter((b) => b.near_miss)
      .sort((a, b) => b.vote_count - a.vote_count);
    // The long tail — books picked by only 1 or 2 voters, no subject coding
    const longTail = data.books
      .filter((b) => !b.in_top_100 && !b.near_miss)
      .sort((a, b) => b.vote_count - a.vote_count || a.title.localeCompare(b.title));

    const isAll = view.mode === "all";

    const top100Items = top100.map((b) => bookListItem(b)).join("");
    const nearMissItems = nearMisses
      .map((b) => bookListItem(b, `${b.author} · ${b.vote_count} voters`))
      .join("");
    const longTailItems = longTail
      .map((b) => bookListItem(b, `${b.author} · ${b.vote_count} voter${b.vote_count === 1 ? "" : "s"}`))
      .join("");

    const introCopy = isAll
      ? `<p><strong>All ${data.books.length} books</strong> picked by at least one voter — the top 100, plus 594 more that didn't make the cut. 172 voters each submitted a ranked top-10 (1,720 ballots total).</p>
         <p class="hint">Note: the chart's binary F/M math excludes the 2 non-binary voters from denominator and curves; they still appear in voter lists and rankings.</p>`
      : `<p><strong>The chart</strong> places each novel at its subject-matter score (x-axis) versus the share of its F/M voters who are women (y-axis). Dot size shows how many voters chose it.</p>
         <p class="hint">The 2 non-binary voters are excluded from the binary chart math but still appear in voter lists and rankings.</p>`;

    panel.innerHTML = `
      <div class="overview-intro">
        ${introCopy}
        <p class="hint">
          Click any dot to see its voters.<br>
          Click a voter's name to see their other picks.<br>
          Click empty space to come back here.
        </p>
      </div>

      <div class="tab-bar" role="tablist">
        <button class="tab" data-tab="books" role="tab">Top 100</button>
        ${isAll ? `<button class="tab" data-tab="nearmiss" role="tab">Near-misses (${nearMisses.length})</button>` : ""}
        ${isAll ? `<button class="tab" data-tab="longtail" role="tab">Long tail (${longTail.length})</button>` : ""}
        <button class="tab" data-tab="rankings" role="tab">Rankings</button>
      </div>

      <div class="tab-panel" data-panel="books">
        <div class="panel-section">
          <div class="panel-kicker">The 100 books, in reveal order (100&nbsp;→&nbsp;1)</div>
          <ul class="panel-list panel-list--ranked">${top100Items}</ul>
        </div>
      </div>

      ${isAll ? `
      <div class="tab-panel" data-panel="nearmiss">
        <div class="panel-section">
          <div class="panel-kicker">Books with 3+ voters that missed the top 100</div>
          <p class="hint" style="margin-top:0">These appear on the chart as dashed-outlined dots.</p>
          <ul class="panel-list panel-list--ranked">${nearMissItems}</ul>
        </div>
      </div>

      <div class="tab-panel" data-panel="longtail">
        <div class="panel-section">
          <div class="panel-kicker">The long tail (1–2 voters, no subject coding)</div>
          <p class="hint" style="margin-top:0">Picked by one or two voters apiece. Not chartable but reachable through voter ballots.</p>
          <ul class="panel-list panel-list--ranked">${longTailItems}</ul>
        </div>
      </div>
      ` : ""}

      <div class="tab-panel" data-panel="rankings">
        ${renderRankings()}
      </div>
    `;
    // Reset the active tab if we just exited a mode that had a tab not in the new layout
    const validTabs = Array.from(panel.querySelectorAll(".tab")).map((b) => b.dataset.tab);
    if (!validTabs.includes(activeTab)) activeTab = "books";
    activateTab(activeTab);
    wireTabClicks();
    wirePanelClicks();
  }

  function renderBookPanel(book) {
    const voters = book.voters.map((vid) => votersById.get(vid));
    voters.sort((a, b) => a.name.localeCompare(b.name));
    const voterItems = voters.map((v) => `
      <li data-voter="${v.id}">
        ${voterMarkerHtml(v)}
        <span>${escapeHtml(v.name)}</span>
        <span class="secondary">${v.ballot.length} picks</span>
      </li>`).join("");

    panel.innerHTML = `
      <a class="back-link" data-action="overview">&larr; all books</a>
      <div class="panel-section">
        <div class="panel-kicker">${book.in_top_100 ? `Rank #${book.rank}` : "Not in top 100"} &middot; ${book.vote_count} voters</div>
        <h2 class="panel-title">${escapeHtml(book.title)}</h2>
        <p class="panel-author">by ${escapeHtml(book.author)} &middot;
          <span style="color: var(--${book.author_gender === 'F' ? 'red' : 'blue'})">
            ${book.author_gender === 'F' ? 'female author' : book.author_gender === 'M' ? 'male author' : 'author'}
          </span>
        </p>
        <p class="panel-meta">
          ${book.year ? `Published <strong>${book.year}</strong> &middot; ` : ''}
          ${book.subject !== null ? `Subject <strong>${formatScore(book.subject)}</strong> &middot; ` : ''}
          ${book.canonicity !== null ? `Canonicity <strong>${formatScore(book.canonicity)}</strong>` : ''}
        </p>
        <p class="panel-meta"><strong>${pctInHighlighted(book).toFixed(0)}%</strong> of voters are ${groupDef().label}</p>
      </div>
      <div class="panel-section">
        <div class="panel-kicker">Voters (${voters.length})</div>
        <ul class="panel-list">${voterItems}</ul>
      </div>
    `;
    wirePanelClicks();
  }

  function renderVoterPanel(voter) {
    const showAll = view.mode === "all";
    const ballot = showAll ? voter.ballot : voter.ballot.filter((p) => p.rank !== null);
    ballot.sort((a, b) => (a.position || 99) - (b.position || 99));
    const items = ballot.map((p) => {
      const b = booksByKey.get(p.book_key);
      const author = p.author || (b ? b.author : "");
      const ag = b ? b.author_gender : "unknown";
      const inTop = p.rank !== null;
      return `
        <li data-book="${p.book_key || ''}" ${!p.book_key ? 'style="opacity:0.6;cursor:default"' : ""}>
          <span class="rank-num">${p.position}</span>
          <span class="marker ${ag}"></span>
          <span class="book-title">${escapeHtml(p.title || (b ? b.title : ""))}</span>
          <span class="secondary">${inTop ? `#${p.rank}` : "(not in top 100)"}</span>
        </li>`;
    }).join("");

    const m = voterMetrics(voter);

    const possessive =
      voter.gender === "F" ? "Her picks" :
      voter.gender === "M" ? "His picks" :
      "Their picks";

    panel.innerHTML = `
      <a class="back-link" data-action="overview">&larr; all books</a>
      <div class="panel-section">
        <div class="panel-kicker">Voter</div>
        <h2 class="panel-title">${escapeHtml(voter.name)}</h2>
        <p class="panel-meta" style="margin-top:6px">
          <span style="color: var(--${voter.gender === 'F' ? 'red' : voter.gender === 'M' ? 'blue' : 'ink'})">${
            voter.gender === 'F' ? 'female' : voter.gender === 'M' ? 'male' : voter.gender}</span>
          ${voter.note ? '&middot; ' + escapeHtml(voter.note) : ''}
        </p>
        <p class="panel-meta" style="margin-top:8px">${ballot.length} ${showAll ? "picks shown (full top-10)" : "picks in top-100 (of 10 total)"}</p>
      </div>
      <div class="panel-section voter-metrics">
        <div class="panel-kicker">Voting profile (${showAll ? "all picks" : "top-100 only"})</div>
        <ul class="metrics-list">
          <li><span class="metric-key">mean subject</span><span class="metric-val">${formatScore(m.mean_subject)}</span></li>
          <li><span class="metric-key">spread (σ)</span><span class="metric-val">${(m.std_subject ?? 0).toFixed(2)}</span></li>
          ${m.mean_canonicity != null ? `<li><span class="metric-key">mean canonicity</span><span class="metric-val">${formatScore(m.mean_canonicity)}</span></li>` : ''}
          ${m.mean_year != null ? `<li><span class="metric-key">avg publication yr</span><span class="metric-val">${Math.round(m.mean_year)}</span></li>` : ''}
          ${m.pct_authors_by_group?.gender ? `<li><span class="metric-key">% to female authors</span><span class="metric-val">${m.pct_authors_by_group.gender.F.toFixed(0)}%</span></li>` : ''}
          <li><span class="metric-key">avg pick popularity</span><span class="metric-val">${(m.mean_pick_popularity ?? 0).toFixed(1)} voters/book</span></li>
        </ul>
      </div>
      <div class="panel-section">
        <div class="panel-kicker">${possessive}</div>
        <ul class="panel-list panel-list--ranked">${items}</ul>
      </div>
    `;
    wirePanelClicks();
  }

  function wirePanelClicks() {
    panel.querySelectorAll("[data-voter]").forEach((el) => {
      el.addEventListener("click", () => setNav({ kind: "voter", id: el.dataset.voter }));
    });
    panel.querySelectorAll("[data-book]").forEach((el) => {
      const k = el.dataset.book;
      if (k) el.addEventListener("click", () => setNav({ kind: "book", id: k }));
    });
    panel.querySelectorAll('[data-action="overview"]').forEach((el) => {
      el.addEventListener("click", (e) => { e.preventDefault(); setNav({ kind: "overview", id: null }); });
    });
  }

  // ---------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------
  const tooltip = document.getElementById("tooltip");
  function showTooltip(event, d) {
    const groupLbl = groupDef().label;
    tooltip.innerHTML = `
      <div class="tt-title">${escapeHtml(d.title)}</div>
      <div class="tt-author">${escapeHtml(d.author)}</div>
      <div class="tt-meta">${d.rank ? `#${d.rank} &middot; ` : ''}${d.vote_count} voters &middot; ${pctInHighlighted(d).toFixed(0)}% ${groupLbl}</div>
    `;
    tooltip.hidden = false;
    moveTooltip(event);
  }
  function moveTooltip(event) {
    const pad = 14;
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    const r = tooltip.getBoundingClientRect();
    if (left + r.width > window.innerWidth - 8) left = event.clientX - r.width - pad;
    if (top + r.height > window.innerHeight - 8) top = event.clientY - r.height - pad;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }
  function hideTooltip() { tooltip.hidden = true; }

  // ---------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------
  function wireControls() {
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => onChangeView({ mode: btn.dataset.mode }));
    });
  }

  function onChangeView(partial) {
    if (partial.mode) view.mode = partial.mode;
    document.querySelectorAll(".mode-btn").forEach((b) =>
      b.setAttribute("aria-selected", b.dataset.mode === view.mode));
    saveViewState();
    renderChart();
    applyNav();
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  wireControls();
  // sync mode/axis buttons' aria-selected with loaded state
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.setAttribute("aria-selected", b.dataset.mode === view.mode));
  renderChart();
  setNav(readHash(), { fromHash: true });
})();
