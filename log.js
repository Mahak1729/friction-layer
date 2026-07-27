// The Friction Layer - log page. Raw log (newest first) + weekly bar chart.

function categorize(e) {
  if (e.dismissed) return "dismissed";
  if (e.outcome === "full" && (e.accepted || e.forcedThrough)) return "engaged";
  return "let";
}

function outcomeLabel(e) {
  if (e.kind === "skip") return "Skipped (Pre-Filter)";
  if (e.dismissed) return "Dismissed (Escape)";
  if (e.outcome === "full") {
    if (e.accepted) return "Full Friction, Engaged";
    if (e.forcedThrough) return "Full Friction, Let Through After 2 Rejections";
    return "Full Friction";
  }
  if (e.outcome === "nudge") return "Light Nudge";
  if (e.failOpen) return "Let Through (API Failure)";
  if (e.outcome === "none") return "Let Through";
  return e.outcome || "-";
}

function titleCase(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SITE_LABELS = { chatgpt: "ChatGPT", claude: "Claude" };
function siteLabel(site) {
  return SITE_LABELS[site] || titleCase(site);
}

// Monday of the week the timestamp falls in.
function weekStart(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

function weekLabel(d) {
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = (x) =>
    x.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return fmt(d) + " to " + fmt(end);
}

function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayLabel(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bucketize(entries, bucketStartFn) {
  const buckets = new Map();
  for (const e of entries) {
    if (!e.ts) continue;
    const bs = bucketStartFn(e.ts);
    const key = bs.toISOString();
    if (!buckets.has(key)) {
      buckets.set(key, { date: bs, engaged: 0, dismissed: 0, let: 0 });
    }
    buckets.get(key)[categorize(e)] += 1;
  }
  return Array.from(buckets.values()).sort((a, b) => a.date - b.date);
}

function renderBarChart(wrapId, buckets, labelFn) {
  const wrap = document.getElementById(wrapId);
  wrap.innerHTML = "";
  if (buckets.length === 0) {
    wrap.innerHTML = '<div class="empty">Nothing logged yet.</div>';
    return;
  }

  const COLORS = { engaged: "#2A9D6F", dismissed: "#D97D3D", let: "#3B6E8F" };
  const max = Math.max(
    1,
    ...buckets.map((w) => Math.max(w.engaged, w.dismissed, w.let))
  );

  const barW = 22;
  const gap = 4;
  const groupW = barW * 3 + gap * 2;
  const groupGap = 42;
  const chartH = 180;
  const padL = 34;
  const padB = 40;
  const padT = 12;
  const width = padL + buckets.length * (groupW + groupGap) + 10;
  const height = chartH + padT + padB;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  // y-axis: baseline + max gridline
  const baseline = document.createElementNS(svgNS, "line");
  baseline.setAttribute("x1", padL);
  baseline.setAttribute("x2", width - 4);
  baseline.setAttribute("y1", padT + chartH);
  baseline.setAttribute("y2", padT + chartH);
  baseline.setAttribute("stroke", "#333333");
  baseline.setAttribute("stroke-width", "2");
  svg.appendChild(baseline);

  const maxLabel = document.createElementNS(svgNS, "text");
  maxLabel.setAttribute("x", padL - 8);
  maxLabel.setAttribute("y", padT + 10);
  maxLabel.setAttribute("text-anchor", "end");
  maxLabel.setAttribute("font-size", "12");
  maxLabel.setAttribute("fill", "#333333");
  maxLabel.textContent = String(max);
  svg.appendChild(maxLabel);

  buckets.forEach((w, i) => {
    const gx = padL + i * (groupW + groupGap) + groupGap / 2;
    ["engaged", "dismissed", "let"].forEach((cat, j) => {
      const value = w[cat];
      const h = Math.round((value / max) * (chartH - 8));
      const x = gx + j * (barW + gap);
      const y = padT + chartH - h;
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", barW);
      rect.setAttribute("height", h);
      rect.setAttribute("fill", COLORS[cat]);
      svg.appendChild(rect);
      if (value > 0) {
        const t = document.createElementNS(svgNS, "text");
        t.setAttribute("x", x + barW / 2);
        t.setAttribute("y", y - 4);
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("font-size", "11");
        t.setAttribute("fill", "#333333");
        t.textContent = String(value);
        svg.appendChild(t);
      }
    });
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", gx + groupW / 2);
    label.setAttribute("y", padT + chartH + 22);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", "12");
    label.setAttribute("fill", "#333333");
    label.textContent = labelFn(w.date);
    svg.appendChild(label);
  });

  wrap.appendChild(svg);
}

function buildCharts(entries) {
  renderBarChart("chart-wrap", bucketize(entries, weekStart), weekLabel);
  renderBarChart("chart-wrap-daily", bucketize(entries, dayStart), dayLabel);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderEntry(e) {
  const entry = el("div", "entry");

  const head = el("div", "head");
  const when = e.ts ? new Date(e.ts).toLocaleString() : "-";
  head.appendChild(el("span", "when", when + (e.site ? "  ·  " + siteLabel(e.site) : "")));
  head.appendChild(el("span", "outcome " + categorize(e), outcomeLabel(e)));
  entry.appendChild(head);

  if (e.message) entry.appendChild(el("div", "msg", "“" + e.message + "”"));

  const kv = (label, value) => {
    if (value == null || value === "") return;
    const line = el("div", "kv");
    const b = el("b", null, label + ": ");
    line.appendChild(b);
    line.appendChild(document.createTextNode(String(value)));
    entry.appendChild(line);
  };

  kv("Reason", e.reason);
  if (e.outcome === "full") {
    kv("Category", titleCase(e.category));
    kv("Question", e.question);
    if (Array.isArray(e.attempts)) {
      e.attempts.forEach((a, i) => {
        const verdict =
          a.genuine === true
            ? "Accepted"
            : a.genuine === false
              ? "Rejected"
              : "Unchecked (API Failure)";
        kv("Answer Attempt " + (i + 1) + " (" + verdict + ")", a.answer);
        if (a.feedback) kv("  Nudge Back", a.feedback);
      });
    }
    if (e.accepted || e.forcedThrough) {
      kv("Append Toggle", e.appendOn ? "On" : "Off");
    }
  }
  kv("Nudge", e.nudge);
  if (e.failOpen) kv("Fail-Open", "an API call failed or timed out");

  if (Array.isArray(e.context) && e.context.length > 0) {
    const details = document.createElement("details");
    const summary = el("summary", null, "Context judged against (" + e.context.length + " messages)");
    details.appendChild(summary);
    for (const m of e.context) {
      details.appendChild(
        el("div", "ctx", "[" + titleCase(m.role) + "] " + (m.text || "").slice(0, 400))
      );
    }
    entry.appendChild(details);
  }

  return entry;
}

chrome.storage.local.get("frictionLog").then(({ frictionLog = [] }) => {
  buildCharts(frictionLog);
  const container = document.getElementById("entries");
  if (frictionLog.length === 0) {
    container.innerHTML = '<div class="empty">Nothing logged yet.</div>';
    return;
  }
  for (const e of [...frictionLog].reverse()) {
    container.appendChild(renderEntry(e));
  }
});
