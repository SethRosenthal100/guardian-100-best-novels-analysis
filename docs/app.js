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

// ---------------------------------------------------------------------
// Tab switcher (runs immediately — no data dependency)
// ---------------------------------------------------------------------
(function setupTabs() {
  const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
  const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
  function activate(name) {
    for (const btn of tabButtons) {
      const isActive = btn.dataset.tab === name;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    for (const panel of tabPanels) {
      panel.classList.toggle("hidden", panel.dataset.tab !== name);
    }
    try { localStorage.setItem("tab", name); } catch (e) {}
  }
  for (const btn of tabButtons) {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  }
  // Restore last-active tab on load; fall back to first tab.
  let initial = null;
  try { initial = localStorage.getItem("tab"); } catch (e) {}
  const valid = tabButtons.some((b) => b.dataset.tab === initial);
  activate(valid ? initial : (tabButtons[0] && tabButtons[0].dataset.tab));
})();

(async function () {
  // ---------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------
  const W = 980;
  const H = 780;
  const M = { top: 8, right: 30, bottom: 96, left: 100 };
  const MARGINAL_H = 210;
  const MAIN_TOP = M.top + MARGINAL_H;
  const MAIN_H = H - MAIN_TOP - M.bottom;

  // ---------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------
  const data = await fetch("data_extended.json?v=1").then((r) => r.json());
  const booksByKey = new Map(data.books.map((b) => [b.key, b]));
  const votersById = new Map(data.voters.map((v) => [v.id, v]));

  // Author -> sorted list of books; authorSlug -> author name (for hash routing)
  const slugifyAuthor = (s) => s.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "");
  const booksByAuthor = new Map();
  for (const b of data.books) {
    if (!b.author) continue;
    if (!booksByAuthor.has(b.author)) booksByAuthor.set(b.author, []);
    booksByAuthor.get(b.author).push(b);
  }
  for (const arr of booksByAuthor.values()) {
    arr.sort((a, b) => (b.vote_count - a.vote_count) || a.title.localeCompare(b.title));
  }
  const authorBySlug = new Map();
  for (const author of booksByAuthor.keys()) authorBySlug.set(slugifyAuthor(author), author);
  const axesByKey = new Map(data.axes.map((a) => [a.key, a]));

  // Cluster lookups
  const clusterItems = (data.clusters && data.clusters.items) || [];
  const clustersById = new Map(clusterItems.map((c) => [c.id, c]));
  function clusterName(c) {
    if (!c) return "";
    const top = c.top_book_keys && c.top_book_keys[0]
      ? booksByKey.get(c.top_book_keys[0])
      : null;
    return top ? top.title : `Cluster ${c.id}`;
  }

  // Update every "All N books" pill (one per tab) to the actual count.
  document.querySelectorAll(".mode-all-count").forEach((el) => {
    el.textContent = data.books.length.toLocaleString();
  });

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
    .select("#chart-gender-trends")
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
    const yKde = d3.scaleLinear().domain([0, peak * 1.3]).range([M.top + MARGINAL_H, M.top + 8]);

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

    // y-axis ticks: descriptive vertical endpoints + horizontal percentage mids.
    [0, 25, 50, 75, 100].forEach((t) => {
      const isGenderEndpoint = view.axis === "gender" && (t === 0 || t === 100);
      if (isGenderEndpoint) {
        const labelText = t === 100 ? "All female" : "All male";
        const anchor    = t === 100 ? "end" : "start";
        gMain.append("text")
          .attr("class", "axis-label")
          .attr("transform", `translate(${M.left - 15}, ${y(t)}) rotate(-90)`)
          .attr("text-anchor", anchor)
          .attr("dominant-baseline", "central")
          .text(labelText);
      } else {
        gMain.append("text")
          .attr("class", "y-tick")
          .attr("x", M.left - 8)
          .attr("y", y(t))
          .attr("text-anchor", "end")
          .attr("dominant-baseline", "central")
          .text(`${t}%`);
      }
    });
    const yLabel = view.axis === "gender"
      ? `Voter gender*`
      : `Percentage of voters for each book who are ${groupLabel(highlighted)}`;
    gMain.append("text")
      .attr("class", "axis-title")
      .attr("transform", `translate(${M.left - 75}, ${MAIN_TOP + MAIN_H / 2}) rotate(-90)`)
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
      .attr("class", "axis-title")
      .attr("x", x(0)).attr("y", axisY + 38)
      .attr("text-anchor", "middle")
      .text("Stereotypical categorization of books as male/female based on subject and style");

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
    else if (nav.kind === "author") h = `#author/${nav.id}`;
    else if (nav.kind === "cluster") h = `#cluster/${nav.id}`;
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
    } else if (h.startsWith("#author/")) {
      const slug = decodeURIComponent(h.slice(8));
      if (authorBySlug.has(slug)) return { kind: "author", id: slug };
    } else if (h.startsWith("#cluster/")) {
      const id = parseInt(h.slice(9), 10);
      if (clustersById.has(id)) return { kind: "cluster", id };
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
    // Network nodes get the same dim/focus/highlight classes so a single
    // selection drives all charts in lockstep.
    const netNodes = d3.selectAll(".net-node")
      .classed("dim", false)
      .classed("focus", false)
      .classed("highlight", false);
    // Donut spokes — same dim/focus/highlight pattern (one class per voter).
    const donutSpokes = d3.selectAll(".donut-spoke")
      .classed("dim", false)
      .classed("focus", false)
      .classed("highlight", false);

    if (nav.kind === "book") {
      const book = booksByKey.get(nav.id);
      gDots.selectAll("circle.dot")
        .classed("dim", (d) => d.key !== nav.id)
        .classed("focus", (d) => d.key === nav.id);
      netNodes
        .classed("dim", (d) => d.key !== nav.id)
        .classed("focus", (d) => d.key === nav.id);
      // Donut: dim spokes whose voter didn't pick this book; highlight those who did.
      if (book) {
        const voterIdsForBook = new Set(book.voters || []);
        donutSpokes
          .classed("dim", (d) => !voterIdsForBook.has(d.voter.id))
          .classed("highlight", (d) => voterIdsForBook.has(d.voter.id));
        drawLabels([book]);
      }
      renderBookPanel(book);
    } else if (nav.kind === "voter") {
      const voter = votersById.get(nav.id);
      if (!voter) { setNav({ kind: "overview", id: null }); return; }
      const ballotKeys = new Set(voter.ballot.map((p) => p.book_key));
      gDots.selectAll("circle.dot")
        .classed("dim", (d) => !ballotKeys.has(d.key))
        .classed("highlight", (d) => ballotKeys.has(d.key));
      netNodes
        .classed("dim", (d) => !ballotKeys.has(d.key))
        .classed("highlight", (d) => ballotKeys.has(d.key));
      donutSpokes
        .classed("dim", (d) => d.voter.id !== voter.id)
        .classed("focus", (d) => d.voter.id === voter.id);
      const labelBooks = voter.ballot
        .map((p) => booksByKey.get(p.book_key))
        .filter((b) => b && rank_to_xy[b.key]);
      drawLabels(labelBooks);
      renderVoterPanel(voter);
    } else if (nav.kind === "cluster") {
      const cluster = clustersById.get(nav.id);
      if (!cluster) { setNav({ kind: "overview", id: null }); return; }
      // Books in this cluster
      const inCluster = (b) => b.cluster_id === cluster.id;
      gDots.selectAll("circle.dot")
        .classed("dim", (d) => !inCluster(d))
        .classed("highlight", (d) => inCluster(d));
      netNodes
        .classed("dim", (d) => !inCluster(d))
        .classed("highlight", (d) => inCluster(d));
      // Voters whose dominant cluster (in current mode) matches.
      const topOnly = view.mode === "top100";
      donutSpokes
        .classed("dim", (d) => d.dominant !== cluster.id)
        .classed("highlight", (d) => d.dominant === cluster.id);
      // Labels: top books in the cluster that are on-chart in the current mode.
      const labelBooks = (cluster.top_book_keys || [])
        .map((k) => booksByKey.get(k))
        .filter((b) => b && rank_to_xy[b.key]);
      drawLabels(labelBooks);
      renderClusterPanel(cluster);
    } else if (nav.kind === "author") {
      const author = authorBySlug.get(nav.id);
      if (!author) { setNav({ kind: "overview", id: null }); return; }
      const books = booksByAuthor.get(author) || [];
      const bookKeys = new Set(books.map((b) => b.key));
      gDots.selectAll("circle.dot")
        .classed("dim", (d) => !bookKeys.has(d.key))
        .classed("highlight", (d) => bookKeys.has(d.key));
      netNodes
        .classed("dim", (d) => !bookKeys.has(d.key))
        .classed("highlight", (d) => bookKeys.has(d.key));
      // Donut: voters who picked any of this author's books → highlight.
      const voterIdsForAuthor = new Set();
      for (const b of books) for (const vid of (b.voters || [])) voterIdsForAuthor.add(vid);
      donutSpokes
        .classed("dim", (d) => !voterIdsForAuthor.has(d.voter.id))
        .classed("highlight", (d) => voterIdsForAuthor.has(d.voter.id));
      drawLabels(books.filter((b) => rank_to_xy[b.key]));
      renderAuthorPanel(author, books);
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
    const cr = md.rankings_cluster || {};
    const m = (v) => voterMetrics(v);
    const cm = (v) => (m(v) && m(v).cluster) || {};

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
        <div class="panel-kicker">Cluster behavior rankings</div>
        ${rankingBlock("Most cluster-diverse",
          "Touches the most distinct clusters across their 10 picks.",
          cr.most_cluster_diverse,
          (v) => `${cm(v).n_distinct} clusters touched`)}
        ${rankingBlock("Anchored in the &lsquo;canon&rsquo;",
          "Most picks in the densely-voted central canon cluster.",
          cr.anchored_in_canon,
          (v) => `${cm(v).canon_count}/10 in canon`)}
        ${rankingBlock("Anchored in a niche cluster",
          "Dominant cluster is one of the smallest in the network.",
          cr.anchored_in_niche,
          (v) => `${cm(v).dom_count}/10 in a ${cm(v).dom_cluster_size}-book cluster`)}
        ${rankingBlock("Picks popular books",
          "Their ten picks together collected the most votes overall.",
          cr.picks_popular_books,
          (v) => `${cm(v).sum_vote_count} total votes`)}
        ${rankingBlock("Picks obscure books",
          "Their ten picks together collected the fewest votes overall.",
          cr.picks_obscure_books,
          (v) => `${cm(v).sum_vote_count} total votes`)}
        ${rankingBlock("Most off-grid",
          "Most picks that don't fall in any cluster (or missed the cut, in top-100 scope).",
          cr.most_off_grid,
          (v) => `${cm(v).off_grid_count}/10 off-grid`)}
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
    // Near-misses (3+ voters, coded for subject/canonicity)
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

    // Vote-share split: how concentrated is the canon? Sum votes for top-100
    // vs the rest. Should sum close to total_picks = 172 voters × 10 = 1720.
    const top100Votes = top100.reduce((s, b) => s + b.vote_count, 0);
    const otherBooks = data.books.length - 100;
    const totalPicks = data.voters.reduce((s, v) => s + v.ballot.length, 0);
    const otherVotes = totalPicks - top100Votes;
    const top100Share = Math.round((top100Votes / totalPicks) * 100);
    const otherShare = 100 - top100Share;

    panel.innerHTML = `
      <div class="overview-intro">
        <p><strong>${data.voters.length} voters</strong>, ten picks each — ${totalPicks.toLocaleString()} ballots across <strong>${data.books.length.toLocaleString()}</strong> distinct books.</p>
        <p>The Guardian's <strong>top 100</strong> captured <strong>${top100Share}%</strong> of those picks (${top100Votes.toLocaleString()} votes); the other <strong>${otherBooks}</strong> books accounted for the remaining <strong>${otherShare}%</strong> (${otherVotes.toLocaleString()} votes).</p>
        <p class="hint">
          Click any book or voter to see who they connect to.<br>
          Click a cluster swatch to see the books in that cluster.<br>
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
        <p class="panel-author">by ${
          (booksByAuthor.get(book.author) || []).length > 1
            ? `<a class="author-link" data-author="${slugifyAuthor(book.author)}">${escapeHtml(book.author)}</a>`
            : escapeHtml(book.author)
        } &middot;
          <span style="color: var(--${book.author_gender === 'F' ? 'red' : 'blue'})">
            ${book.author_gender === 'F' ? 'female author' : book.author_gender === 'M' ? 'male author' : 'author'}
          </span>
        </p>
        <p class="panel-meta">
          ${book.year ? `Published <strong>${book.year}</strong>` : ''}${book.year && book.subject !== null ? ' &middot; ' : ''}${book.subject !== null ? `Subject <strong>${formatScore(book.subject)}</strong>` : ''}
        </p>
        <p class="panel-meta"><strong>${pctInHighlighted(book).toFixed(0)}%</strong> of voters are ${groupDef().label}</p>
        ${clusterRowHtml(book)}
      </div>
      <div class="panel-section">
        <div class="panel-kicker">Voters (${voters.length})</div>
        <ul class="panel-list">${voterItems}</ul>
      </div>
    `;
    wirePanelClicks();
  }

  function clusterRowHtml(book) {
    if (book.cluster_id === null || book.cluster_id === undefined) return "";
    const c = clustersById.get(book.cluster_id);
    if (!c) return "";
    return `<p class="panel-meta panel-cluster-row">
      <a class="cluster-link" data-cluster="${c.id}">
        <span class="cluster-swatch" style="background:${c.color}"></span>
        <span>Cluster: <strong>${escapeHtml(clusterName(c))}</strong> + ${c.book_count - 1} others &rarr;</span>
      </a>
    </p>`;
  }

  function renderClusterPanel(cluster) {
    const allBooks = data.books.filter((b) => b.cluster_id === cluster.id);
    allBooks.sort((a, b) =>
      (b.vote_count - a.vote_count) || a.title.localeCompare(b.title));

    const bookItems = allBooks.map((b) => `
      <li data-book="${b.key}">
        <span>${escapeHtml(b.title)}</span>
        <span class="secondary">${escapeHtml(b.author || "")} &middot; ${b.vote_count}</span>
      </li>`).join("");

    // Voters whose dominant cluster matches in the current mode.
    const topOnly = view.mode === "top100";
    const matchingVoters = data.voters
      .map((v) => ({ v, spoke: spokeFor(v, topOnly) }))
      .filter((x) => x.spoke.dominant === cluster.id)
      .sort((a, b) => (b.spoke.dominantCount - a.spoke.dominantCount) || a.v.name.localeCompare(b.v.name));

    const voterItems = matchingVoters.slice(0, 12).map(({ v, spoke }) => `
      <li data-voter="${v.id}">
        ${voterMarkerHtml(v)}
        <span>${escapeHtml(v.name)}</span>
        <span class="secondary">${spoke.dominantCount}/10 in this cluster</span>
      </li>`).join("");

    panel.innerHTML = `
      <a class="back-link" data-action="overview">&larr; all books</a>
      <div class="panel-section">
        <div class="panel-kicker">Cluster</div>
        <h2 class="panel-title">
          <span class="cluster-swatch cluster-swatch-large" style="background:${cluster.color}"></span>
          ${escapeHtml(clusterName(cluster))}
        </h2>
        <p class="panel-author">${cluster.book_count} books &middot; ${cluster.vote_count} total votes &middot; ${cluster.votes_per_book} votes/book on average</p>
      </div>
      <div class="panel-section">
        <div class="panel-kicker">Books in cluster (${allBooks.length})</div>
        <ul class="panel-list">${bookItems}</ul>
      </div>
      ${matchingVoters.length ? `
        <div class="panel-section">
          <div class="panel-kicker">Voters anchored here (${matchingVoters.length})</div>
          <ul class="panel-list">${voterItems}</ul>
        </div>` : ""}
    `;
    wirePanelClicks();
  }

  function renderAuthorPanel(author, books) {
    const totalPicks = books.reduce((s, b) => s + b.vote_count, 0);
    const gender = books[0]?.author_gender;
    const items = books.map((b) => `
      <li data-book="${b.key}">
        <span class="marker ${b.author_gender}"></span>
        <span class="book-title">${escapeHtml(b.title)}</span>
        <span class="secondary">${b.vote_count} voter${b.vote_count === 1 ? '' : 's'}${b.in_top_100 ? ` &middot; #${b.rank}` : ''}</span>
      </li>`).join("");

    panel.innerHTML = `
      <a class="back-link" data-action="overview">&larr; all books</a>
      <div class="panel-section">
        <div class="panel-kicker">Author</div>
        <h2 class="panel-title">${escapeHtml(author)}</h2>
        <p class="panel-meta" style="margin-top:6px">
          <span style="color: var(--${gender === 'F' ? 'red' : gender === 'M' ? 'blue' : 'ink'})">
            ${gender === 'F' ? 'female author' : gender === 'M' ? 'male author' : 'author'}</span>
        </p>
        <p class="panel-meta" style="margin-top:8px">
          ${books.length} book${books.length === 1 ? '' : 's'} in this dataset
          &middot; ${totalPicks} total pick${totalPicks === 1 ? '' : 's'}
        </p>
      </div>
      <div class="panel-section">
        <div class="panel-kicker">Books</div>
        <ul class="panel-list panel-list--ranked">${items}</ul>
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
    panel.querySelectorAll("[data-author]").forEach((el) => {
      el.addEventListener("click", (e) => { e.preventDefault(); setNav({ kind: "author", id: el.dataset.author }); });
    });
    panel.querySelectorAll('[data-action="overview"]').forEach((el) => {
      el.addEventListener("click", (e) => { e.preventDefault(); setNav({ kind: "overview", id: null }); });
    });
    panel.querySelectorAll("[data-cluster]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const id = parseInt(el.dataset.cluster, 10);
        if (!Number.isNaN(id)) setNav({ kind: "cluster", id });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------
  const tooltip = document.getElementById("tooltip");
  function showTooltipHtml(event, html) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    moveTooltip(event);
  }
  function showTooltip(event, d) {
    const groupLbl = groupDef().label;
    const cluster = (d.cluster_id !== null && d.cluster_id !== undefined)
      ? clustersById.get(d.cluster_id)
      : null;
    showTooltipHtml(event, `
      <div class="tt-title">${escapeHtml(d.title)}</div>
      <div class="tt-author">${escapeHtml(d.author)}</div>
      <div class="tt-meta">${d.rank ? `#${d.rank} &middot; ` : ''}${d.vote_count} voters &middot; ${pctInHighlighted(d).toFixed(0)}% ${groupLbl}${cluster ? ` &middot; cluster: ${escapeHtml(clusterName(cluster))}` : ''}</div>
    `);
  }
  function showVoterTooltip(event, spoke) {
    const v = spoke.voter;
    const genderLabel = v.gender === "F" ? "female voter"
      : v.gender === "M" ? "male voter"
      : "non-binary voter";
    const dom = spoke.dominant !== null ? clustersById.get(spoke.dominant) : null;
    showTooltipHtml(event, `
      <div class="tt-title">${escapeHtml(v.name)}</div>
      <div class="tt-meta">${genderLabel} &middot; ${spoke.nDistinct} cluster${spoke.nDistinct === 1 ? "" : "s"}${dom ? ` &middot; anchor: ${escapeHtml(clusterName(dom))}` : ""}</div>
    `);
  }
  function showClusterTooltip(event, cluster) {
    showTooltipHtml(event, `
      <div class="tt-title">Cluster: ${escapeHtml(clusterName(cluster))}</div>
      <div class="tt-meta">${cluster.book_count} books &middot; ${cluster.vote_count} votes &middot; ${cluster.votes_per_book} per book</div>
    `);
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
    renderBookClusters();
    renderVoterClusters();
    applyNav();
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------
  const searchInput   = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");

  // Build a single corpus of {type, id, label, sublabel} entries.
  const searchCorpus = [
    ...data.books.map((b) => ({
      type: "book", id: b.key, label: b.title, sublabel: b.author || ""
    })),
    ...Array.from(booksByAuthor.entries()).map(([author, bks]) => ({
      type: "author", id: slugifyAuthor(author), label: author,
      sublabel: `${bks.length} book${bks.length === 1 ? '' : 's'}`
    })),
    ...data.voters.map((v) => ({
      type: "voter", id: v.id, label: v.name,
      sublabel: v.gender === "F" ? "female" : v.gender === "M" ? "male" : "non-binary"
    })),
  ];

  // Match scoring: exact > label-prefix > label-word-boundary > sublabel-prefix
  // > sublabel-word-boundary > label-substring > sublabel-substring.
  // Tie-break by type preference: author > book > voter.
  const TYPE_PRIORITY = { author: 2, book: 1, voter: 0 };
  function scoreMatch(label, sublabel, q) {
    label = label.toLowerCase();
    sublabel = (sublabel || "").toLowerCase();
    if (label === q) return 100;
    if (sublabel === q) return 80;
    if (label.startsWith(q)) return 50;
    if (sublabel.startsWith(q)) return 25;
    const wb = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (wb.test(label)) return 30;
    if (wb.test(sublabel)) return 12;
    if (label.includes(q)) return 5;
    if (sublabel.includes(q)) return 2;
    return 0;
  }

  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      searchResults.hidden = true;
      searchResults.innerHTML = "";
      return;
    }
    const scored = [];
    for (const it of searchCorpus) {
      const s = scoreMatch(it.label, it.sublabel, q);
      if (s > 0) scored.push({ ...it, score: s });
    }
    scored.sort((a, b) =>
      (b.score - a.score) || (TYPE_PRIORITY[b.type] - TYPE_PRIORITY[a.type])
    );

    if (scored.length === 0) {
      searchResults.innerHTML = `<div class="search-empty">No matches</div>`;
      searchResults.hidden = false;
      return;
    }

    const LIMIT = 15;
    const visible = scored.slice(0, LIMIT);
    const html = visible.map((it) =>
      `<a class="search-result" href="#${it.type}/${escapeAttr(it.id)}" data-type="${it.type}" data-id="${escapeAttr(it.id)}">
        <span class="search-result-type type-${it.type}">${it.type}</span>
        <span class="search-result-main">
          <span class="search-result-label">${escapeHtml(it.label)}</span>
          <span class="search-result-sub">${escapeHtml(it.sublabel)}</span>
        </span>
      </a>`
    ).join("");
    const more = scored.length > LIMIT
      ? `<div class="search-more">+${scored.length - LIMIT} more matches</div>` : "";
    searchResults.innerHTML = html + more;
    searchResults.hidden = false;
    searchResults.querySelectorAll(".search-result").forEach((el) => {
      el.addEventListener("click", (e) => {
        // Plain left-click navigates internally and clears the search.
        // Cmd/Ctrl-click, middle-click, etc. fall through to default
        // browser behaviour (open in new tab), preserving link semantics.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        setNav({ kind: el.dataset.type, id: el.dataset.id });
        searchInput.value = "";
        searchResults.hidden = true;
        searchResults.innerHTML = "";
      });
    });
  }

  function escapeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

  searchInput.addEventListener("input", runSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      runSearch();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Results are sorted by relevance, so the top result is the best match.
      const first = searchResults.querySelector(".search-result");
      if (first) first.click();
    }
  });

  // ---------------------------------------------------------------------
  // Book Clusters network — rendered once on page load from baked layout
  // ---------------------------------------------------------------------
  // Width chosen to match the scatter's W=980 so the two charts feel like
  // peers when you tab between them. Height is taller to fit the network's
  // typical aspect.
  const NW = 980;
  const NH = 920;
  const NET_PADDING = 70;

  // Cluster color lookup by id
  const clusterColor = new Map();
  for (const c of (data.clusters && data.clusters.items) || []) {
    clusterColor.set(c.id, c.color);
  }
  const defaultGray =
    (data.clusters && data.clusters.default_gray) || "#cccccc";

  // Pixel-radius from baked sizing recipe: area = 80 + 30*votes → r = √(area/π).
  function netRadius(votes) {
    return Math.sqrt((80 + 30 * votes) / Math.PI);
  }

  const netSvg = d3
    .select("#chart-book-clusters")
    .attr("viewBox", `0 0 ${NW} ${NH}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  function renderBookClusters() {
    netSvg.selectAll("*").remove();
    if (!data.book_edges) return;
    const topOnly = view.mode === "top100";

    const booksInGraph = data.books.filter(
      (b) => b.cluster_id !== null && b.cluster_id !== undefined
    );
    if (!booksInGraph.length) return;

    // Top-100 books that didn't connect to the cluster graph — Beloved,
    // Wuthering Heights, etc. They appear as a pseudo-cluster in the top-
    // right area of the chart (where the spring layout leaves whitespace).
    // Pale blue flags them as "outside any cluster" without disappearing.
    const ORPHAN_COLOR = "#88B9DD";
    const orphans = data.books
      .filter((b) => (b.cluster_id === null || b.cluster_id === undefined) && b.in_top_100)
      .sort((a, b) => a.rank - b.rank);

    // Network layout uses the full viewBox now that orphans live as their own
    // small floating cluster rather than in a reserved strip.
    const xs = booksInGraph.map((b) => b.layout_x);
    const ys = booksInGraph.map((b) => b.layout_y);
    const xn = d3.scaleLinear()
      .domain([Math.min(...xs), Math.max(...xs)])
      .range([NET_PADDING, NW - NET_PADDING]);
    const yn = d3.scaleLinear()
      .domain([Math.min(...ys), Math.max(...ys)])
      .range([NH - NET_PADDING, NET_PADDING]);

    const gEdges = netSvg.append("g").attr("class", "g-net-edges");
    const gNodes = netSvg.append("g").attr("class", "g-net-nodes");
    const gNetLabels = netSvg.append("g").attr("class", "g-net-labels");

    netSvg.insert("rect", ":first-child")
      .attr("class", "background-hit")
      .attr("x", 0).attr("y", 0)
      .attr("width", NW).attr("height", NH)
      .on("click", () => setNav({ kind: "overview", id: null }));

    // -------- Orphan pseudo-cluster in the top-right --------
    if (orphans.length) {
      const gOrphans = netSvg.append("g").attr("class", "g-net-orphans");

      // Cluster center + bounding radius. Sit in the top-right whitespace.
      const orphCx = NW * 0.84;
      const orphCy = NH * 0.17;
      const orphR = 78;

      // Faint dashed boundary — flags the group as a "loose" pseudo-cluster
      // (not a real modularity community).
      gOrphans.append("circle")
        .attr("class", "net-orphan-boundary")
        .attr("cx", orphCx)
        .attr("cy", orphCy)
        .attr("r", orphR + 14);

      // Hand-placed dots + label directions for the top 4 by votes — keeps
      // the labels stacked predictably so the right side of the chart stays
      // legible. Other orphans pick random polar slots and resolve overlaps
      // via push-apart.
      const TOP4_LAYOUT = {
        "Beloved": {
          dotFrac: { x: -0.25, y: -0.55 },
          label:   { vx: -1, vy: -0.30, anchor: "end" },
        },
        "Bleak House": {
          dotFrac: { x: -0.30, y: -0.05 },
          label:   { vx: -1, vy:  0.05, anchor: "end" },
        },
        "Things Fall Apart": {
          dotFrac: { x: -0.10, y:  0.55 },
          label:   { vx: -1, vy:  0.25, anchor: "end" },
        },
        "Wuthering Heights": {
          dotFrac: { x:  0.40, y:  0.10 },
          label:   { vx:  1, vy:  0,    anchor: "start" },
        },
      };

      let randIdx = 0;
      const nRandom = orphans.length - Object.keys(TOP4_LAYOUT)
        .filter((t) => orphans.some((b) => b.title === t)).length;
      const positions = orphans.map((b) => {
        const hard = TOP4_LAYOUT[b.title];
        if (hard) {
          return {
            book: b,
            x: orphCx + hard.dotFrac.x * orphR,
            y: orphCy + hard.dotFrac.y * orphR,
            r: netRadius(b.vote_count),
            locked: true,
            labelSlot: hard.label,
          };
        }
        const baseAngle = (randIdx / Math.max(nRandom, 1)) * 2 * Math.PI;
        const angleJitter = (hashKey(b.key, 11) - 0.5) * 0.7;
        const angle = baseAngle + angleJitter;
        const radiusFrac = 0.45 + hashKey(b.key, 23) * 0.50;
        randIdx++;
        return {
          book: b,
          x: orphCx + orphR * radiusFrac * Math.cos(angle),
          y: orphCy + orphR * radiusFrac * Math.sin(angle),
          r: netRadius(b.vote_count),
          locked: false,
        };
      });

      // Push-apart that respects locked positions — only unlocked dots move.
      for (let iter = 0; iter < 120; iter++) {
        let moved = 0;
        for (let i = 0; i < positions.length; i++) {
          for (let j = i + 1; j < positions.length; j++) {
            const dx = positions[j].x - positions[i].x;
            const dy = positions[j].y - positions[i].y;
            const dist = Math.hypot(dx, dy);
            const minDist = positions[i].r + positions[j].r + 4;
            if (dist < minDist && dist > 0.01) {
              const push = (minDist - dist);
              const ux = dx / dist;
              const uy = dy / dist;
              if (positions[i].locked && positions[j].locked) continue;
              if (positions[i].locked) {
                positions[j].x += ux * push;
                positions[j].y += uy * push;
              } else if (positions[j].locked) {
                positions[i].x -= ux * push;
                positions[i].y -= uy * push;
              } else {
                positions[i].x -= ux * (push / 2);
                positions[i].y -= uy * (push / 2);
                positions[j].x += ux * (push / 2);
                positions[j].y += uy * (push / 2);
              }
              moved++;
            }
          }
        }
        if (!moved) break;
      }

      // Render dots
      positions.forEach((p) => {
        gOrphans.append("circle")
          .attr("class", "net-node net-orphan")
          .attr("data-key", p.book.key)
          .attr("cx", p.x).attr("cy", p.y)
          .attr("r", p.r)
          .attr("fill", ORPHAN_COLOR)
          .datum(p.book)
          .on("click", (event, d) => {
            event.stopPropagation();
            setNav({ kind: "book", id: d.key });
          })
          .on("mouseenter", (event, d) => showTooltip(event, d))
          .on("mousemove", moveTooltip)
          .on("mouseleave", hideTooltip);
      });

      // Labels for the hand-placed top-4 — direction comes from labelSlot,
      // text sits just past the dot edge along that direction.
      positions.forEach((pos) => {
        if (!pos.labelSlot) return;
        const slot = pos.labelSlot;
        const vlen = Math.hypot(slot.vx, slot.vy) || 1;
        const ux = slot.vx / vlen;
        const uy = slot.vy / vlen;
        const closeDist = pos.r + 14;
        const sx = pos.x + ux * closeDist;
        const sy = pos.y + uy * closeDist;
        const textPadX = slot.anchor === "start" ? 4 : -4;
        gOrphans.append("line")
          .attr("class", "net-orphan-line")
          .attr("x1", pos.x + ux * pos.r)
          .attr("y1", pos.y + uy * pos.r)
          .attr("x2", sx).attr("y2", sy);
        gOrphans.append("text")
          .attr("class", "net-orphan-label")
          .attr("x", sx + textPadX).attr("y", sy)
          .attr("text-anchor", slot.anchor)
          .attr("dominant-baseline", "middle")
          .text(pos.book.title);
      });

      // Caption just below the dashed boundary
      gOrphans.append("text")
        .attr("class", "net-orphan-caption")
        .attr("x", orphCx)
        .attr("y", orphCy + orphR + 26)
        .attr("text-anchor", "middle")
        .text("Orphans: not in any cluster, but in top 100");
    }

    const isCanonicalDimmed = (b) => topOnly && !b.in_top_100;

    gEdges.selectAll("line.net-edge")
      .data(data.book_edges)
      .enter()
      .append("line")
      .attr("class", "net-edge")
      .classed("net-edge-dim", (d) =>
        isCanonicalDimmed(booksByKey.get(d.a)) ||
        isCanonicalDimmed(booksByKey.get(d.b)))
      .attr("x1", (d) => xn(booksByKey.get(d.a).layout_x))
      .attr("y1", (d) => yn(booksByKey.get(d.a).layout_y))
      .attr("x2", (d) => xn(booksByKey.get(d.b).layout_x))
      .attr("y2", (d) => yn(booksByKey.get(d.b).layout_y));

    gNodes.selectAll("circle.net-node")
      .data(booksInGraph, (d) => d.key)
      .enter()
      .append("circle")
      .attr("class", "net-node")
      .classed("out-of-scope", isCanonicalDimmed)
      .attr("data-key", (d) => d.key)
      .attr("cx", (d) => xn(d.layout_x))
      .attr("cy", (d) => yn(d.layout_y))
      .attr("r", (d) => isCanonicalDimmed(d) ? 2.0 : netRadius(d.vote_count))
      .attr("fill", (d) => isCanonicalDimmed(d)
        ? "#bcbcbc"
        : (clusterColor.get(d.cluster_id) || defaultGray))
      .on("click", (event, d) => {
        event.stopPropagation();
        setNav({ kind: "book", id: d.key });
      })
      .on("mouseenter", (event, d) => showTooltip(event, d))
      .on("mousemove", moveTooltip)
      .on("mouseleave", hideTooltip);

    // Label the most-voted books. In top-100 mode, only top-100 books are
    // candidates so the network reads as an annotated canon-overlay.
    const TOP_N_LABELS = 30;
    const labelCandidates = topOnly
      ? booksInGraph.filter((b) => b.in_top_100)
      : booksInGraph;
    const labelBooks = [...labelCandidates]
      .sort((a, b) => b.vote_count - a.vote_count)
      .slice(0, TOP_N_LABELS);

    gNetLabels.selectAll("text.net-label")
      .data(labelBooks)
      .enter()
      .append("text")
      .attr("class", "net-label")
      .attr("x", (d) => xn(d.layout_x))
      .attr("y", (d) => yn(d.layout_y) - netRadius(d.vote_count) - 4)
      .attr("text-anchor", "middle")
      .text((d) => d.title);
  }

  // ---------------------------------------------------------------------
  // Voter Clusters donut — radial spokes (one per voter), dominant-cluster
  // first at the inner edge, plus a compact paired-circles legend showing
  // top-5 clusters' book-count vs vote-count.
  // ---------------------------------------------------------------------
  const VW = 980;
  const VH = 1020;  // taller than the network so callout banks above + below
                   // the donut have breathing room

  const voterSvg = d3
    .select("#chart-voter-clusters")
    .attr("viewBox", `0 0 ${VW} ${VH}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Compute a voter's donut spoke for the given mode. Returns
  //   { voter, sorted_picks, dominant, dominantCount, nDistinct }
  // where sorted_picks is 10 cluster ids (dominant cluster first, gray −1 at
  // the outer end). In top-100 mode, picks whose book isn't in_top_100 turn
  // into gray segments regardless of cluster membership.
  function spokeFor(voter, topOnly) {
    const segs = [];
    for (const p of voter.ballot) {
      const b = booksByKey.get(p.book_key);
      if (!b) { segs.push(-1); continue; }
      if (topOnly && !b.in_top_100) { segs.push(-1); continue; }
      const cid = b.cluster_id;
      segs.push((cid !== null && cid !== undefined) ? cid : -1);
    }
    const inGraph = segs.filter((c) => c >= 0);
    const outGraph = segs.filter((c) => c < 0);
    const counts = new Map();
    for (const c of inGraph) counts.set(c, (counts.get(c) || 0) + 1);
    const sortedCounts = [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
    const sorted_picks = [];
    for (const [c, n] of sortedCounts) for (let i = 0; i < n; i++) sorted_picks.push(c);
    sorted_picks.push(...outGraph);
    while (sorted_picks.length < 10) sorted_picks.push(-1);
    return {
      voter,
      sorted_picks: sorted_picks.slice(0, 10),
      dominant: sortedCounts.length ? sortedCounts[0][0] : null,
      dominantCount: sortedCounts.length ? sortedCounts[0][1] : 0,
      nDistinct: counts.size,
    };
  }

  // Pick a small set of voter spokes to call out with static labels. Each
  // criterion picks one spoke; duplicates are de-duped so a single standout
  // (e.g. Nussaibah Younis = both "most concentrated" AND "anchored in tiny
  // cluster") gets one label rather than two.
  // Top voter of each cluster ranking + the two identity-based against-trend
  // rankings (F and M voters going against the gender pattern). Anti-collision
  // happens at render time when the labels are placed in two banks above and
  // below the donut.
  function pickCallouts(spokes) {
    const picks = [];
    const seen = new Set();
    const spokeById = new Map(spokes.map((s) => [s.voter.id, s]));
    const cr = (modeData().rankings_cluster) || {};
    const trend = ((byAxis() || {}).rankings_against_trend) || {};

    function addRanking(ids, labelFn) {
      const id = (ids || [])[0];
      if (!id || seen.has(id)) return;
      const spoke = spokeById.get(id);
      if (!spoke) return;
      const label = labelFn(spoke);
      if (!label) return;
      seen.add(id);
      picks.push({ spoke, label });
    }

    // Cluster rankings (6 callouts) — the build script also emits
    // most_cluster_loyal and bridges_two_clusters; intentionally not surfaced
    // here because they lean hardest on cluster *meaning*, which is loose
    // for the long-tail clusters.
    addRanking(cr.anchored_in_niche, (s) => {
      const c = clustersById.get(s.dominant);
      return c ? `${s.dominantCount}/10 in a ${c.book_count}-book cluster` : null;
    });
    addRanking(cr.anchored_in_canon, (s) => `${s.dominantCount}/10 in the ‘canon’`);
    addRanking(cr.most_cluster_diverse, (s) => `${s.nDistinct} clusters across 10 picks`);
    addRanking(cr.picks_popular_books, (s) => {
      const cm = voterMetrics(s.voter) && voterMetrics(s.voter).cluster;
      return cm ? `picks sum ${cm.sum_vote_count} votes` : null;
    });
    addRanking(cr.picks_obscure_books, (s) => {
      const cm = voterMetrics(s.voter) && voterMetrics(s.voter).cluster;
      return cm ? `picks sum just ${cm.sum_vote_count} votes` : null;
    });
    addRanking(cr.most_off_grid, (s) => {
      const grayCount = s.sorted_picks.filter((c) => c < 0).length;
      return grayCount > 0 ? `${grayCount}/10 off-grid` : null;
    });

    // Identity-based: F and M voters going furthest against the gender pattern.
    addRanking(trend.F_against_trend, (s) => {
      const m = voterMetrics(s.voter) || {};
      const ms = m.mean_subject;
      if (ms === null || ms === undefined) return "F voter, against pattern";
      return ms < 0 ? "F voter, male-coded ballot" : "F voter, very female-coded";
    });
    addRanking(trend.M_against_trend, (s) => {
      const m = voterMetrics(s.voter) || {};
      const ms = m.mean_subject;
      if (ms === null || ms === undefined) return "M voter, against pattern";
      return ms > 0 ? "M voter, female-coded ballot" : "M voter, very male-coded";
    });

    return picks;
  }

  function renderVoterClusters() {
    voterSvg.selectAll("*").remove();
    const topOnly = view.mode === "top100";

    const spokes = data.voters
      .filter((v) => v.ballot && v.ballot.length)
      .map((v) => spokeFor(v, topOnly));
    if (!spokes.length) return;

    // Order around the ring: concentrated → diverse going clockwise. Voters
    // with no in-graph picks (possible in top-100 mode when every pick missed
    // the cut) sort to the very end as fully-gray spokes.
    spokes.sort((a, b) => {
      const aHas = a.dominant !== null;
      const bHas = b.dominant !== null;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      if (!aHas && !bHas) return 0;
      return (a.nDistinct - b.nDistinct)
        || (b.dominantCount - a.dominantCount)
        || (a.dominant - b.dominant);
    });

    // Donut + legend layout. Legend dims are proportional to donut radius:
    //   p_col  = column-centre spacing as fraction of outerR
    //   p_circ = max legend-circle radius as fraction of outerR
    //   p_row  = legend vertical half-span as fraction of outerR
    // Donut radius is sized to use whatever width budget remains after the
    // legend column on the right — donut grows when legend shrinks.
    const PAD = 30;
    const P_COL = 0.20;
    const P_CIRC = 0.06;
    const P_ROW = 0.36;

    // widthBudget = 2*outerR + outerR*(P_COL + P_COL/2 + P_CIRC) + 2*PAD
    const widthBudget = VW - PAD * 2;
    const widthMult = 2 + 1.5 * P_COL + P_CIRC;
    const heightBudget = VH - 180;  // reserve top + bottom for callout banks
    const outerR = Math.min(widthBudget / widthMult, heightBudget / 2);

    const donutCx = PAD + outerR;
    const donutCy = VH * 0.50;
    const innerR = outerR * 0.45;
    const segs = 10;
    const segThickness = (outerR - innerR) / segs;

    const tau = Math.PI * 2;
    const voterArc = tau / spokes.length;

    // Background hit area resets nav
    voterSvg.append("rect")
      .attr("class", "background-hit")
      .attr("x", 0).attr("y", 0)
      .attr("width", VW).attr("height", VH)
      .on("click", () => setNav({ kind: "overview", id: null }));

    const gDonut = voterSvg.append("g")
      .attr("class", "g-donut")
      .attr("transform", `translate(${donutCx}, ${donutCy})`);

    // Per-voter spoke: a `g` element containing 10 segment paths.
    const arcGen = d3.arc();

    const spokeSel = gDonut.selectAll("g.donut-spoke")
      .data(spokes, (d) => d.voter.id)
      .enter()
      .append("g")
      .attr("class", "donut-spoke")
      .attr("data-voter", (d) => d.voter.id)
      .style("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation();
        setNav({ kind: "voter", id: d.voter.id });
      })
      .on("mouseenter", (event, d) => showVoterTooltip(event, d))
      .on("mousemove", moveTooltip)
      .on("mouseleave", hideTooltip);

    spokeSel.each(function (d, i) {
      // d3 arcs start at 12 o'clock and sweep clockwise when angles increase.
      const theta0 = i * voterArc;
      const theta1 = (i + 1) * voterArc;
      const g = d3.select(this);
      for (let si = 0; si < segs; si++) {
        const cid = d.sorted_picks[si];
        const fill = cid < 0
          ? "#e8e8e8"
          : (clusterColor.get(cid) || defaultGray);
        const r1 = innerR + si * segThickness;
        const r2 = innerR + (si + 1) * segThickness;
        const dPath = arcGen({
          innerRadius: r1,
          outerRadius: r2,
          startAngle: theta0,
          endAngle: theta1,
        });
        g.append("path")
          .attr("class", "donut-seg")
          .attr("data-cluster", cid)
          .attr("d", dPath)
          .attr("fill", fill);
      }
    });

    // Inner + outer guide rings
    gDonut.append("circle")
      .attr("class", "donut-ring")
      .attr("r", innerR);
    gDonut.append("circle")
      .attr("class", "donut-ring")
      .attr("r", outerR);

    // -------- Inner annotation: clockwise arrow + sort-direction label --------
    // Short arc starting just past 12 o'clock and sweeping ~55° clockwise,
    // with a small arrowhead at its end. Says "spokes go from concentrated
    // → diverse" so the donut's narrative direction is unmistakable.
    const annR = innerR * 0.58;
    const annStart = 0.18;      // radians past 12 o'clock
    const annEnd = annStart + 0.95;   // ~54° sweep
    const ax0 = annR * Math.sin(annStart);
    const ay0 = -annR * Math.cos(annStart);
    const ax1 = annR * Math.sin(annEnd);
    const ay1 = -annR * Math.cos(annEnd);
    const gAnn = gDonut.append("g").attr("class", "g-donut-inner-arrow");
    gAnn.append("path")
      .attr("class", "donut-inner-arc")
      .attr("d", `M ${ax0} ${ay0} A ${annR} ${annR} 0 0 1 ${ax1} ${ay1}`);
    // Arrowhead at end of arc, oriented along the tangent.
    const tx = Math.cos(annEnd);
    const ty = Math.sin(annEnd);
    const arrSize = 7;
    gAnn.append("polygon")
      .attr("class", "donut-inner-arrow")
      .attr("points", [
        `${ax1 + tx * arrSize},${ay1 + ty * arrSize}`,
        `${ax1 - ty * arrSize * 0.55},${ay1 + tx * arrSize * 0.55}`,
        `${ax1 + ty * arrSize * 0.55},${ay1 - tx * arrSize * 0.55}`,
      ].join(" "));
    // Two-line label centred in the donut hole.
    const annLabel = gAnn.append("text")
      .attr("class", "donut-inner-label")
      .attr("text-anchor", "middle");
    annLabel.append("tspan")
      .attr("x", 0).attr("y", 10).text("from most concentrated");
    annLabel.append("tspan")
      .attr("x", 0).attr("dy", "1.25em").text("to most diverse");

    // -------- Callouts: top voter of each cluster ranking --------
    // Two-bank layout: voters in the upper hemisphere get a label above the
    // donut; lower hemisphere gets a label below. Within each bank, labels
    // are stacked horizontally with minimum spacing so they don't overlap.
    // Banks never extend past the donut's outer width, so the legend on the
    // right is always clear.
    const callouts = pickCallouts(spokes);
    const lineEnd = outerR + 4;
    const bankPadding = 26;
    const minLabelSpacingPx = 155;
    const bankXClip = outerR - 50;

    // Hand-placed overrides for specific voters whose default bank placement
    // doesn't work well. Each entry can override labelX (relative to spokeX
    // via dx) and labelY (absolute, donut-local). Overridden labels are
    // excluded from the bank anti-collision so they don't push neighbours.
    const SPECIAL_PLACEMENTS = {
      "David Nicholls": { dx: 22, labelY: -outerR + 30 },
    };

    const placements = [];
    callouts.forEach(({ spoke, label }) => {
      const i = spokes.indexOf(spoke);
      if (i < 0) return;
      const theta = (i + 0.5) * voterArc;
      const sx = Math.sin(theta);
      const cy = -Math.cos(theta);
      const spokeX = outerR * sx;
      const spokeY = outerR * cy;
      const isTop = cy < 0;
      const placement = {
        spoke, label, theta,
        spokeX, spokeY, isTop,
        labelX: spokeX,
        labelY: isTop ? -(outerR + bankPadding) : (outerR + bankPadding),
        manual: false,
      };
      const override = SPECIAL_PLACEMENTS[spoke.voter.name];
      if (override) {
        placement.manual = true;
        if (override.dx !== undefined) placement.labelX = spokeX + override.dx;
        if (override.labelY !== undefined) placement.labelY = override.labelY;
      }
      placements.push(placement);
    });

    // Anti-collision: within each bank, sort by labelX, enforce min spacing,
    // then clamp into [-bankXClip, bankXClip]. If the bank still overflows
    // tighten spacing uniformly.
    for (const isTop of [true, false]) {
      const bank = placements.filter((p) => p.isTop === isTop && !p.manual)
        .sort((a, b) => a.labelX - b.labelX);
      if (!bank.length) continue;
      for (let i = 1; i < bank.length; i++) {
        if (bank[i].labelX - bank[i - 1].labelX < minLabelSpacingPx) {
          bank[i].labelX = bank[i - 1].labelX + minLabelSpacingPx;
        }
      }
      if (bank[bank.length - 1].labelX > bankXClip) {
        const shift = bank[bank.length - 1].labelX - bankXClip;
        bank.forEach((p) => p.labelX -= shift);
      }
      if (bank[0].labelX < -bankXClip) {
        const shift = -bankXClip - bank[0].labelX;
        bank.forEach((p) => p.labelX += shift);
      }
      const spanNeeded = bank[bank.length - 1].labelX - bank[0].labelX;
      const maxSpan = 2 * bankXClip;
      if (spanNeeded > maxSpan && bank.length > 1) {
        const tighter = maxSpan / (bank.length - 1);
        for (let i = 1; i < bank.length; i++) {
          bank[i].labelX = bank[0].labelX + i * tighter;
        }
      }
    }

    const gCallouts = gDonut.append("g").attr("class", "g-donut-callouts");
    placements.forEach((p) => {
      const lineX1 = lineEnd * Math.sin(p.theta);
      const lineY1 = -lineEnd * Math.cos(p.theta);
      const g = gCallouts.append("g")
        .attr("class", "donut-callout")
        .attr("data-voter", p.spoke.voter.id)
        .style("cursor", "pointer")
        .on("click", (event) => {
          event.stopPropagation();
          setNav({ kind: "voter", id: p.spoke.voter.id });
        });
      g.append("line")
        .attr("class", "donut-call-line")
        .attr("x1", lineX1).attr("y1", lineY1)
        .attr("x2", p.labelX).attr("y2", p.labelY);
      const t = g.append("text")
        .attr("class", "donut-call-text")
        .attr("text-anchor", "middle");
      t.append("tspan")
        .attr("class", "donut-call-name")
        .attr("x", p.labelX)
        .attr("y", p.labelY)
        .attr("dy", p.isTop ? "-1em" : "0.9em")
        .text(p.spoke.voter.name);
      t.append("tspan")
        .attr("class", "donut-call-sub")
        .attr("x", p.labelX)
        .attr("dy", "1.15em")
        .text(p.label);
    });

    // -------- Legend on the right --------
    // Proportions are the P_COL / P_CIRC / P_ROW constants set above. Donut
    // outerR is sized to use the width remaining after the legend.
    const top5 = (data.clusters.items || []).slice(0, 5);
    const maxBookVote = Math.max(
      ...top5.map((c) => Math.max(c.book_count, c.vote_count))
    );

    const legCircleMaxR = outerR * P_CIRC;
    const colGap = outerR * P_COL;
    const legendCx = donutCx + outerR + colGap;
    const legColBooks = legendCx - colGap / 2;
    const legColVotes = legendCx + colGap / 2;
    const legendTopY = donutCy - outerR * P_ROW;
    const legendBotY = donutCy + outerR * P_ROW;
    const legendRowH = (legendBotY - legendTopY) / Math.max(top5.length - 1, 1);

    function legR(v) {
      return legCircleMaxR * Math.sqrt(v / maxBookVote);
    }

    const gLegend = voterSvg.append("g").attr("class", "g-donut-legend");

    // Group title sits above the column headers
    const headOffset = legCircleMaxR + 14;
    const titleOffset = headOffset + 18;
    gLegend.append("text")
      .attr("class", "donut-legend-title")
      .attr("x", legendCx)
      .attr("y", legendTopY - titleOffset)
      .attr("text-anchor", "middle")
      .text("Top 5 Clusters");
    gLegend.append("text")
      .attr("class", "donut-legend-head")
      .attr("x", legColBooks)
      .attr("y", legendTopY - headOffset)
      .attr("text-anchor", "middle")
      .text("Books");
    gLegend.append("text")
      .attr("class", "donut-legend-head")
      .attr("x", legColVotes)
      .attr("y", legendTopY - headOffset)
      .attr("text-anchor", "middle")
      .text("Votes");

    top5.forEach((c, i) => {
      const y = legendTopY + i * legendRowH;
      const rb = legR(c.book_count);
      const rv = legR(c.vote_count);
      const onClusterClick = (event) => {
        event.stopPropagation();
        setNav({ kind: "cluster", id: c.id });
      };
      const onClusterHover = (event) => showClusterTooltip(event, c);
      gLegend.append("circle")
        .attr("class", "donut-legend-circle")
        .attr("data-cluster", c.id)
        .attr("cx", legColBooks).attr("cy", y).attr("r", rb)
        .attr("fill", c.color)
        .on("click", onClusterClick)
        .on("mouseenter", onClusterHover)
        .on("mousemove", moveTooltip)
        .on("mouseleave", hideTooltip);
      gLegend.append("text")
        .attr("class", "donut-legend-num")
        .attr("x", legColBooks).attr("y", y + legCircleMaxR + 11)
        .attr("text-anchor", "middle")
        .text(c.book_count);
      gLegend.append("circle")
        .attr("class", "donut-legend-circle")
        .attr("data-cluster", c.id)
        .attr("cx", legColVotes).attr("cy", y).attr("r", rv)
        .attr("fill", c.color)
        .on("click", onClusterClick)
        .on("mouseenter", onClusterHover)
        .on("mousemove", moveTooltip)
        .on("mouseleave", hideTooltip);
      gLegend.append("text")
        .attr("class", "donut-legend-num")
        .attr("x", legColVotes).attr("y", y + legCircleMaxR + 11)
        .attr("text-anchor", "middle")
        .text(c.vote_count);
    });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  wireControls();
  // sync mode/axis buttons' aria-selected with loaded state
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.setAttribute("aria-selected", b.dataset.mode === view.mode));
  renderChart();
  renderBookClusters();
  renderVoterClusters();
  setNav(readHash(), { fromHash: true });
})();
