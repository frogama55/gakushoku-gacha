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
  // 設定の既定値を変えたら SETTINGS_VERSION を上げる（古い保存値のチェック状態を無視する）
  const SETTINGS_VERSION = 2;
  const persist = () => store.save({
    v: SETTINGS_VERSION, caf: state.caf, budget: Number($("budget").value),
    requireMain: $("requireMain").checked, allowDup: $("allowDup").checked,
  });

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, "0");
  const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const yen = (n) => `¥${n.toLocaleString("ja-JP")}`;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const cafeteria = () => data.cafeterias.find((c) => c.id === state.caf);

  // 平日（月〜金）だけを対象にする。週は食堂ごとに持つ（PDFの更新タイミングが食堂ごとに違うため）
  function weekDates(caf = cafeteria()) {
    const start = parseIso(caf.weekStart);
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
      const topping = caf.toppings?.[m.name]?.[date];
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

  // レア判定：全部同じ（3個以上）→ SSR、同じものが4個以上 → SR
  function rarityOf(picks) {
    if (picks.length < 3) return null;
    const counts = {};
    picks.forEach((p) => { counts[p.name] = (counts[p.name] || 0) + 1; });
    const [name, qty] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (Object.keys(counts).length === 1) return { tier: "ssr", name, qty, label: `★★★ 伝説：${name} ×${qty} ★★★` };
    if (qty >= 4) return { tier: "sr", name, qty, label: `★ レア：${name} ×${qty} ★` };
    return null;
  }

  // 予算をちょうど使い切ったときの一言（出やすいので複数からランダム）
  const EXACT_PHRASES = [
    "予算ぴったり！",
    "1円の無駄もなし",
    "お釣りゼロの美学",
    "財布、きれいに空っぽ",
    "完全燃焼",
    "計算どおり（たぶん）",
    "見事な使い切り",
    "レジの人も感心",
    "ジャストミート！",
    "残高ゼロ、悔いもゼロ",
  ];

  // 結果の一言。上から順に当てはまったものを出す（必ず何か出す）
  function verdict(picks, rest) {
    if (!picks.length) return "";
    const mains = picks.filter((p) => p.main).length;
    if (mains >= 3) return "大食いチャレンジ！";
    if (picks.length >= 10) return "トレーに乗り切らない";
    if (mains === 0) return "主食なし…勇気ある構成";
    if (picks.length === 1) return "潔く一品勝負";
    if (picks.length >= 6) return "品数お祭り";
    if (mains === 2) return "主食ダブル！";
    if (rest === 0) return pick(EXACT_PHRASES);
    if (picks.length === 2) return "名コンビ誕生";
    return "今日はこれで決まり";
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
    const dates = weekDates();
    const today = isoLocal(new Date());
    if (!dates.includes(state.date)) state.date = dates.includes(today) ? today : dates[0];
    sel.value = state.date;
    renderDataInfo(caf, dates, today);
  }

  function renderDataInfo(caf, dates, today) {
    const s = parseIso(dates[0]);
    const e = parseIso(dates[dates.length - 1]);
    const range = `${s.getMonth() + 1}/${s.getDate()}〜${e.getMonth() + 1}/${e.getDate()}`;
    let text = `${caf.name}の掲載メニュー：${range}（${data.updatedAt} 更新）`;
    const dow = new Date().getDay();
    if (dow === 0 || dow === 6) text += "｜土日は対象外です";
    else if (today > dates[dates.length - 1]) text += "｜今週のメニューは準備中です。最新の掲載分で回しています";
    $("dataInfo").textContent = text;
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

  const MACHINE_FX = ["spinning", "dropped", "shake", "shake-soft", "glow-gold", "glow-rainbow", "explode"];
  function resetMachine() {
    $("machine").classList.remove(...MACHINE_FX);
    $("capsule").className = "capsule";
    $("burst").innerHTML = "";
  }
  function clearResult() { $("result").hidden = true; resetMachine(); }

  // ---------- spin ----------
  function showResult({ picks, rest, error }, budget, rarity) {
    const result = $("result");
    const ul = $("picks");
    ul.innerHTML = "";
    result.classList.remove("sr", "ssr");
    if (rarity) result.classList.add(rarity.tier);
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
    $("badge").textContent = rarity ? rarity.label : verdict(picks, rest);
    $("total").textContent = yen(total);
    $("rest").textContent = `予算 ${yen(budget)}・残り ${yen(rest)}`;
    state.lastPicks = groups;
    result.hidden = false;
  }

  // 動作確認用：URLに ?demo=ssr / ?demo=sr を付けると、レア演出を必ず出す
  function demoOutcome(items, budget, tier) {
    const cheapest = items.slice().sort((a, b) => a.price - b.price)[0];
    if (!cheapest) return null;
    const n = Math.max(3, Math.floor(budget / cheapest.price));
    const picks = Array(Math.min(n, MAX_ITEMS)).fill(cheapest);
    if (tier === "sr") picks.push(items.find((m) => m.name !== cheapest.name) || cheapest);
    return { picks, rest: Math.max(0, budget - picks.reduce((s, m) => s + m.price, 0)) };
  }

  function burst(count, colors) {
    const box = $("burst");
    box.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const p = document.createElement("span");
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 90 + Math.random() * 110;
      p.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      p.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = `${Math.random() * 0.12}s`;
      box.appendChild(p);
    }
  }

  function flash() {
    const f = $("flash");
    f.classList.remove("on");
    void f.offsetWidth;
    f.classList.add("on");
  }

  async function spin() {
    const budget = Math.floor(Number($("budget").value));
    if (!Number.isFinite(budget) || budget <= 0) {
      $("status").textContent = "予算を入力してください";
      $("budget").focus();
      return;
    }
    persist();
    const items = pool(cafeteria(), state.date, state.slot);
    const demo = new URLSearchParams(location.search).get("demo");
    const outcome = (demo && demoOutcome(items, budget, demo)) || roll(items, budget, {
      requireMain: $("requireMain").checked,
      allowDup: $("allowDup").checked,
    });
    const rarity = rarityOf(outcome.picks);

    const machine = $("machine");
    const capsule = $("capsule");
    const btn = $("spin");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));

    $("result").hidden = true;
    resetMachine();
    void machine.offsetWidth; // restart animation
    capsule.style.background = "";
    btn.disabled = true;

    machine.classList.add("spinning");
    await wait(900);
    machine.classList.remove("spinning");

    if (rarity?.tier === "ssr") {
      // 機械が震えて虹色に光り、爆発して虹のカプセルが現れる
      machine.classList.add("shake", "glow-rainbow");
      await wait(1100);
      if (!reduce) { flash(); burst(32, COLORS); }
      machine.classList.remove("shake");
      machine.classList.add("explode");
      capsule.classList.add("rainbow", "big");
      await wait(1500);
    } else if (rarity?.tier === "sr") {
      // 金色に光って、輝くカプセルが出てくる
      machine.classList.add("shake-soft", "glow-gold");
      await wait(700);
      machine.classList.remove("shake-soft");
      capsule.classList.add("gold");
      machine.classList.add("dropped");
      if (!reduce) burst(14, ["#ffd54a", "#fff3b0", "#f4b63f"]);
      await wait(1000);
    } else {
      capsule.style.background = pick(COLORS);
      machine.classList.add("dropped");
      await wait(450);
    }

    showResult(outcome, budget, rarity);
    btn.disabled = false;
    $("result").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }

  async function copyResult() {
    if (!state.lastPicks.length) return;
    const caf = cafeteria();
    const d = parseIso(state.date);
    const lines = state.lastPicks.map(({ item, qty }) => `・${item.name}${qty > 1 ? ` ×${qty}` : ""} ${yen(item.price * qty)}`);
    const text = `学食ガチャ（${caf.name} ${d.getMonth() + 1}/${d.getDate()} ${data.slots[state.slot]}）\n【${$("badge").textContent}】\n${lines.join("\n")}\n合計 ${$("total").textContent}`;
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
      const load = async (path) => {
        const res = await fetch(path, { cache: "no-cache" });
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        return res.json();
      };
      // cafeterias.json＝手で管理する固定情報、week.json＝自動更新される週ごとのメニュー
      const [base, week] = await Promise.all([load("data/cafeterias.json"), load("data/week.json")]);
      data = {
        ...base,
        updatedAt: week.updatedAt,
        cafeterias: base.cafeterias
          .filter((c) => week.cafeterias[c.id])
          .map((c) => ({ closed: [], closedSlots: {}, notes: {}, toppings: {}, ...c, ...week.cafeterias[c.id] })),
      };
    } catch (e) {
      $("status").textContent = "メニューを読み込めませんでした。時間をおいて再読み込みしてください。";
      $("spin").disabled = true;
      return;
    }

    const saved = store.load();
    state.caf = data.cafeterias.some((c) => c.id === saved.caf) ? saved.caf : data.cafeterias[0].id;
    if (saved.budget > 0) $("budget").value = saved.budget;
    if (saved.v === SETTINGS_VERSION) {
      ["requireMain", "allowDup"].forEach((k) => { if (typeof saved[k] === "boolean") $(k).checked = saved[k]; });
    }

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

    renderCafeterias();
    renderDates();
    renderSlots();
    renderLineup();
  }

  init();
})();
