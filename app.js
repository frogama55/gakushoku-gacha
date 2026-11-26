(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  const SLOT_ORDER = ["morning", "lunch", "dinner"];
  const MAX_ITEMS = 40; // 予算を埋め切るための安全上限
  const COLORS = ["#f4b63f", "#6cc4a1", "#6aa6e8", "#e86a8a", "#a98be0", "#f08a4b"];
  const STORE_KEY = "gakushoku-gacha";

  let data = null;
  const state = { caf: null, date: null, slot: "lunch", lastPicks: [] };

  // ---------- storage (best effort) ----------
  const store = {
    load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } },
    save(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const persist = () => store.save({
    caf: state.caf, budget: Number($("budget").value),
    requireMain: $("requireMain").checked, allowDup: $("allowDup").checked,
  });

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, "0");
  const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const yen = (n) => `¥${n.toLocaleString("ja-JP")}`;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const cafeteria = () => data.cafeterias.find((c) => c.id === state.caf);

  // 平日（月〜金）だけを対象にする
  function weekDates() {
    const start = parseIso(data.weekStart);
    return Array.from({ length: 5 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i); return isoLocal(d);
    });
  }

  function pool(caf, date, slot) {
    if (caf.closed.includes(date)) return [];
    if ((caf.closedSlots?.[date] || []).includes(slot)) return [];
    // 昼の定食などが夕方も出る食堂は dinnerCats で指定
    const alsoDinner = (m) => slot === "dinner" && m.slot === "lunch" && (caf.dinnerCats || []).includes(m.cat);
    const daily = (caf.daily[date] || []).filter((m) => m.slot === slot || alsoDinner(m));
    const regular = caf.regular.filter((m) => m.slots.includes(slot)).map((m) => {
      const topping = m.dailyTopping?.[date];
      return { ...m, name: topping ? `${m.name}（${topping}）` : m.name, regular: true };
    });
    return [...daily, ...regular];
  }

  // ---------- gacha ----------
  function roll(items, budget, opts) {
    const picks = [];
    let rest = budget;
    const used = new Set();
    const affordable = (onlyMain) => items.filter((m) =>
      m.price <= rest && (!onlyMain || m.main) && (opts.allowDup || !used.has(m.name)));
    const take = (m) => { picks.push(m); rest -= m.price; used.add(m.name); };

    if (opts.requireMain) {
      const mains = affordable(true);
      if (!mains.length) return { picks, rest, error: "main" };
      take(pick(mains));
    }
    // 買えるものが無くなるまで、無理やり予算を埋める
    while (picks.length < MAX_ITEMS) {
      const cand = affordable(false);
      if (!cand.length) break;
      take(pick(cand));
    }
    return { picks, rest };
  }

  function verdict(picks) {
    if (!picks.length) return "";
    const counts = {};
    picks.forEach((p) => { counts[p.name] = (counts[p.name] || 0) + 1; });
    const top = Math.max(...Object.values(counts));
    const mains = picks.filter((p) => p.main).length;
    if (top >= 5) return "★ 伝説の偏り ★";
    if (mains >= 3) return "大食いチャレンジ！";
    if (picks.length >= 10) return "トレーに乗り切らない";
    if (mains === 0) return "主食なし…勇気ある構成";
    if (picks.length === 1) return "潔く一品勝負";
    if (picks.length >= 6) return "品数お祭り";
    return "";
  }

  // ---------- render controls ----------
  function renderSeg(el, options, current, onPick) {
    el.innerHTML = "";
    options.forEach(({ value, label, disabled }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(value === current));
      b.disabled = !!disabled;
      b.addEventListener("click", () => onPick(value));
      el.appendChild(b);
    });
  }

  function renderCafeterias() {
    renderSeg($("cafeteria"), data.cafeterias.map((c) => ({ value: c.id, label: c.name })), state.caf, (v) => {
      state.caf = v; persist(); renderCafeterias(); renderDates(); renderSlots(); renderLineup(); clearResult();
    });
  }

  function renderDates() {
    const caf = cafeteria();
    const sel = $("date");
    sel.innerHTML = "";
    weekDates().forEach((iso) => {
      const d = parseIso(iso);
      const o = document.createElement("option");
      o.value = iso;
      const closed = caf.closed.includes(iso);
      const today = iso === isoLocal(new Date()) ? "（今日）" : "";
      o.textContent = `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）${today}${closed ? " 休業" : ""}`;
      sel.appendChild(o);
    });
    if (!weekDates().includes(state.date)) state.date = weekDates()[0];
    sel.value = state.date;
  }

  function renderSlots() {
    const caf = cafeteria();
    const opts = SLOT_ORDER.map((s) => ({
      value: s, label: data.slots[s], disabled: pool(caf, state.date, s).length === 0,
    }));
    if (opts.find((o) => o.value === state.slot)?.disabled) {
      const firstOpen = opts.find((o) => !o.disabled);
      if (firstOpen) state.slot = firstOpen.value;
    }
    renderSeg($("slot"), opts, state.slot, (v) => { state.slot = v; renderSlots(); renderLineup(); clearResult(); });
  }

  function renderLineup() {
    const caf = cafeteria();
    const items = pool(caf, state.date, state.slot).slice().sort((a, b) => a.price - b.price);
    const ul = $("lineup");
    ul.innerHTML = "";
    items.forEach((m) => {
      const li = document.createElement("li");
      li.innerHTML = `<span><span class="tag"></span><span class="n"></span></span><span class="p"></span>`;
      li.querySelector(".tag").textContent = m.regular ? "常設" : "日替り";
      li.querySelector(".n").textContent = (m.corner ? "※" : "") + m.name;
      li.querySelector(".p").textContent = yen(m.price) + (m.note ? "〜" : "");
      ul.appendChild(li);
    });
    $("lineupCount").textContent = `（${items.length}品）`;

    const note = caf.notes?.[state.date];
    const status = $("status");
    if (!items.length) status.textContent = note || "この日・時間帯はメニューがありません";
    else status.textContent = note || `${caf.place}｜${caf.hours}`;
    $("spin").disabled = items.length === 0;
  }

  function clearResult() { $("result").hidden = true; $("machine").classList.remove("dropped"); }

  // ---------- spin ----------
  function showResult({ picks, rest, error }, budget) {
    const result = $("result");
    const ul = $("picks");
    ul.innerHTML = "";
    if (error === "main" || !picks.length) {
      const items = pool(cafeteria(), state.date, state.slot);
      const cheapest = Math.min(...items.filter((m) => !error || m.main).map((m) => m.price));
      $("badge").textContent = "予算が足りない…";
      ul.innerHTML = `<li style="opacity:1;grid-template-columns:1fr">${error === "main" ? "主食" : "メニュー"}の最安は ${yen(cheapest)} です。予算を上げるか、設定を変えてみてください。</li>`;
      $("total").textContent = yen(0);
      $("rest").textContent = "";
      state.lastPicks = [];
      result.hidden = false;
      return;
    }

    // group duplicates, keep first-drawn order
    const groups = [];
    picks.forEach((p) => {
      const g = groups.find((x) => x.item.name === p.name);
      if (g) g.qty++; else groups.push({ item: p, qty: 1 });
    });
    groups.forEach(({ item, qty }, i) => {
      const li = document.createElement("li");
      li.style.animationDelay = `${i * 0.12}s`;
      li.innerHTML = `<span class="dot"></span><span class="name"><span class="t"></span><span class="cat"></span></span><span class="price"></span>`;
      li.querySelector(".dot").style.background = COLORS[i % COLORS.length];
      li.querySelector(".t").textContent = (item.corner ? "※" : "") + item.name;
      li.querySelector(".cat").textContent = item.corner
        ? `※${item.corner}：売り切れ・昼だけの営業で、買えないかも`
        : `${item.regular ? "常設" : "日替り"}・${item.cat}`;
      if (item.corner) li.classList.add("warn");
      li.querySelector(".price").innerHTML = `${yen(item.price * qty)}${qty > 1 ? `<span class="qty">×${qty}</span>` : ""}`;
      ul.appendChild(li);
    });
    const total = budget - rest;
    $("badge").textContent = verdict(picks);
    $("total").textContent = yen(total);
    $("rest").textContent = `予算 ${yen(budget)}・残り ${yen(rest)}`;
    state.lastPicks = groups;
    result.hidden = false;
  }

  function spin() {
    const budget = Math.floor(Number($("budget").value));
    if (!Number.isFinite(budget) || budget <= 0) {
      $("status").textContent = "予算を入力してください";
      $("budget").focus();
      return;
    }
    persist();
    const items = pool(cafeteria(), state.date, state.slot);
    const outcome = roll(items, budget, {
      requireMain: $("requireMain").checked,
      allowDup: $("allowDup").checked,
    });

    const machine = $("machine");
    const btn = $("spin");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("result").hidden = true;
    machine.classList.remove("spinning", "dropped");
    void machine.offsetWidth; // restart animation
    $("capsule").style.background = pick(COLORS);
    btn.disabled = true;
    machine.classList.add("spinning");
    setTimeout(() => {
      machine.classList.remove("spinning");
      machine.classList.add("dropped");
      setTimeout(() => {
        showResult(outcome, budget);
        btn.disabled = false;
        $("result").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
      }, reduce ? 0 : 450);
    }, reduce ? 0 : 900);
  }

  async function copyResult() {
    if (!state.lastPicks.length) return;
    const caf = cafeteria();
    const d = parseIso(state.date);
    const lines = state.lastPicks.map(({ item, qty }) => `・${item.name}${qty > 1 ? ` ×${qty}` : ""} ${yen(item.price * qty)}`);
    const text = `学食ガチャ（${caf.name} ${d.getMonth() + 1}/${d.getDate()} ${data.slots[state.slot]}）\n${lines.join("\n")}\n合計 ${$("total").textContent}`;
    try {
      await navigator.clipboard.writeText(text);
      $("copy").textContent = "コピーしました";
    } catch {
      $("copy").textContent = "コピーできませんでした";
    }
    setTimeout(() => { $("copy").textContent = "結果をコピー"; }, 1600);
  }

  // ---------- init ----------
  function defaultSlot() {
    const h = new Date().getHours();
    return h < 10 ? "morning" : h < 16 ? "lunch" : "dinner";
  }

  async function init() {
    try {
      const res = await fetch("data/menu.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (e) {
      $("status").textContent = "メニューを読み込めませんでした。時間をおいて再読み込みしてください。";
      $("spin").disabled = true;
      return;
    }

    const saved = store.load();
    state.caf = data.cafeterias.some((c) => c.id === saved.caf) ? saved.caf : data.cafeterias[0].id;
    if (saved.budget > 0) $("budget").value = saved.budget;
    ["requireMain", "allowDup"].forEach((k) => { if (typeof saved[k] === "boolean") $(k).checked = saved[k]; });

    const today = isoLocal(new Date());
    const dates = weekDates();
    state.date = dates.includes(today) ? today : dates[0];
    state.slot = defaultSlot();

    [300, 400, 500, 700, 1000].forEach((v) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = yen(v);
      b.addEventListener("click", () => { $("budget").value = v; persist(); });
      $("budgetChips").appendChild(b);
    });

    $("date").addEventListener("change", (e) => { state.date = e.target.value; renderSlots(); renderLineup(); clearResult(); });
    $("budget").addEventListener("change", persist);
    ["requireMain", "allowDup"].forEach((k) => $(k).addEventListener("change", persist));
    $("spin").addEventListener("click", spin);
    $("again").addEventListener("click", spin);
    $("copy").addEventListener("click", copyResult);

    const start = parseIso(data.weekStart);
    const end = parseIso(dates[dates.length - 1]);
    $("dataInfo").textContent = `掲載メニュー：${start.getMonth() + 1}/${start.getDate()}〜${end.getMonth() + 1}/${end.getDate()}（${data.updatedAt} 更新）`;
    const dow = new Date().getDay();
    if (dow === 0 || dow === 6) $("dataInfo").textContent += "｜土日は対象外です";
    else if (!dates.includes(today)) $("dataInfo").textContent += "｜今日の分はまだ反映されていません";

    renderCafeterias();
    renderDates();
    renderSlots();
    renderLineup();
  }

  init();
})();
