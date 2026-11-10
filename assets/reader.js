/*
 * 월부 아티클 서재 — 읽기 도우미
 * - 글자 크기·테마 저장, 읽은 글 표시, 이어 읽기, 키보드 이동, 차례 검색
 * - 원문 HTML은 바꾸지 않는다. 유튜브 등 임베드(oembed)만 화면에서 재생기로 바꿔 보여 준다.
 * - 모든 기록은 이 브라우저의 localStorage에만 저장된다.
 */
(function () {
  "use strict";

  var PREFIX = "weolbu-articles:";
  var THEMES = ["light", "sepia", "dark"];
  var THEME_LABELS = { light: "밝게", sepia: "종이", dark: "어둡게" };
  var FONT_MIN = 14;
  var FONT_MAX = 26;
  var root = document.documentElement;
  var body = document.body;

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (error) {
      /* 저장 공간을 쓸 수 없는 환경에서는 기록 없이 동작한다 */
    }
  }

  /* ---------- 테마 ---------- */

  function currentTheme() {
    var stored = root.getAttribute("data-theme");
    if (stored) return stored;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function updateThemeButtons() {
    var theme = currentTheme();
    document.querySelectorAll("[data-action='theme']").forEach(function (button) {
      button.setAttribute("aria-label", "화면 색: " + THEME_LABELS[theme] + " (누르면 바뀜)");
      button.setAttribute("title", "화면 색: " + THEME_LABELS[theme]);
    });
  }

  function cycleTheme() {
    var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    root.setAttribute("data-theme", next);
    save("theme", next);
    updateThemeButtons();
  }

  /* ---------- 글자 크기 ---------- */

  function currentFontSize() {
    var value = parseFloat(getComputedStyle(root).getPropertyValue("--reader-fs"));
    return isNaN(value) ? 18 : value;
  }

  function changeFontSize(delta) {
    var size = Math.max(FONT_MIN, Math.min(FONT_MAX, currentFontSize() + delta));
    root.style.setProperty("--reader-fs", size + "px");
    save("fontSize", size);
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest ? event.target.closest("[data-action]") : null;
    if (!target) return;
    var action = target.getAttribute("data-action");
    if (action === "theme") cycleTheme();
    if (action === "font-up") changeFontSize(1);
    if (action === "font-down") changeFontSize(-1);
  });

  updateThemeButtons();

  /* ---------- 읽은 글 기록 ---------- */

  var author = body.getAttribute("data-author");

  function readSet(slug) {
    return new Set(load(slug + ":read", []));
  }

  function markRead(slug, id) {
    var set = readSet(slug);
    if (set.has(id)) return;
    set.add(id);
    save(slug + ":read", Array.from(set));
  }

  /* ---------- 글 화면 ---------- */

  function setupArticle() {
    var id = Number(body.getAttribute("data-id"));
    var title = body.getAttribute("data-title") || "";
    save(author + ":last", { id: id, title: title, at: Date.now() });

    // 글 끝(이전·다음 글 버튼)이 보이면 다 읽은 글로 표시한다.
    var end = document.querySelector(".pager");
    if (end && "IntersectionObserver" in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            markRead(author, id);
            observer.disconnect();
          }
        });
      });
      observer.observe(end);
    }

    // 스크롤 진행 막대
    var bar = document.querySelector(".scroll-progress");
    if (bar) {
      var ticking = false;
      var update = function () {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        var ratio = max > 0 ? Math.min(1, window.scrollY / max) : 1;
        bar.style.width = ratio * 100 + "%";
        ticking = false;
      };
      window.addEventListener(
        "scroll",
        function () {
          if (!ticking) {
            ticking = true;
            window.requestAnimationFrame(update);
          }
        },
        { passive: true },
      );
      update();
    }

    // ← → 키로 이전·다음 글 이동
    document.addEventListener("keydown", function (event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      var link = null;
      if (event.key === "ArrowLeft") link = document.querySelector("a[rel='prev']");
      if (event.key === "ArrowRight") link = document.querySelector("a[rel='next']");
      if (link) window.location.href = link.getAttribute("href");
    });

    renderEmbeds();
    markTones();
  }

  /*
   * 어두운 화면·종이 화면 보정용 표식.
   * 원문에는 복사·붙여넣기로 딸려 온 검은 글자색과 흰 배경색이 많아서 어두운 화면에서 글이 사라진다.
   * 화면에 그려진 요소의 인라인 색만 살펴 data-tone 표식을 붙이고, 실제 색 변경은 content.css가 어두운·종이 화면에서만 한다.
   *   ink    : 거의 검은 글자색 → 어두운 화면에서 기본 글자색으로
   *   accent : 어두운 강조색(진한 빨강·파랑 등) → 어두운 화면에서 같은 색조를 밝게
   *   paper  : 흰색·밝은 회색 배경 → 어두운·종이 화면에서 투명하게
   *   marker : 형광펜 같은 색 배경 → 어두운 화면에서 글자를 진하게
   */
  var probe = null;

  function toRgb(value) {
    if (!value || value === "transparent" || value === "inherit" || value === "initial" || value === "currentcolor")
      return null;
    if (!probe) {
      probe = document.createElement("span");
      probe.style.display = "none";
      document.body.appendChild(probe);
    }
    probe.style.color = "";
    probe.style.color = value;
    if (!probe.style.color) return null;
    var match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(probe).color);
    if (!match) return null;
    var alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (alpha < 0.2) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function luminance(rgb) {
    var channel = rgb.map(function (value) {
      var v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2];
  }

  function chroma(rgb) {
    return (Math.max.apply(null, rgb) - Math.min.apply(null, rgb)) / 255;
  }

  function lighten(rgb) {
    // 흰색을 조금씩 섞어 어두운 배경에서 읽을 만한 밝기(휘도 0.35 이상)가 될 때까지 올린다.
    var mixed = rgb.slice();
    for (var step = 1; step <= 10 && luminance(mixed) < 0.35; step += 1) {
      var ratio = step / 10;
      mixed = rgb.map(function (value) {
        return Math.round(value + (255 - value) * ratio);
      });
    }
    return "rgb(" + mixed.join(", ") + ")";
  }

  function addTone(element, tone) {
    var current = element.getAttribute("data-tone");
    element.setAttribute("data-tone", current ? current + " " + tone : tone);
  }

  function markTones() {
    var nodes = document.querySelectorAll(".ck-content [style]");
    nodes.forEach(function (element) {
      var background = toRgb(element.style.backgroundColor);
      if (background) {
        if (luminance(background) > 0.7 && chroma(background) < 0.15) addTone(element, "paper");
        else addTone(element, "marker");
      }
      var color = toRgb(element.style.color);
      if (!color) return;
      var insideMarker = element.closest("[data-tone~='marker']");
      if (insideMarker) return;
      var light = luminance(color);
      if (light < 0.2 && chroma(color) < 0.3) {
        addTone(element, "ink");
      } else if (light < 0.35) {
        addTone(element, "accent");
        element.style.setProperty("--tone-light", lighten(color));
      }
    });
  }

  // CKEditor가 저장한 <oembed url="..."> 는 브라우저가 그리지 못하므로 화면에서만 재생기로 바꾼다.
  function youtubeId(url) {
    var match = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(
      url || "",
    );
    return match ? match[1] : null;
  }

  function renderEmbeds() {
    document.querySelectorAll(".ck-content oembed[url]").forEach(function (node) {
      var url = node.getAttribute("url");
      var video = youtubeId(url);
      var holder = document.createElement("span");
      holder.className = video ? "embed-frame" : "embed-link";
      if (video) {
        var frame = document.createElement("iframe");
        frame.src = "https://www.youtube-nocookie.com/embed/" + video;
        frame.title = "동영상";
        frame.loading = "lazy";
        frame.allowFullscreen = true;
        frame.setAttribute("allow", "accelerometer; encrypted-media; gyroscope; picture-in-picture");
        holder.appendChild(frame);
      } else {
        var anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noopener";
        anchor.textContent = url;
        holder.appendChild(anchor);
      }
      node.appendChild(holder);
    });
  }

  /* ---------- 차례 화면 ---------- */

  function setupToc() {
    var read = readSet(author);
    var items = document.querySelectorAll(".toc-list li[data-id]");
    items.forEach(function (item) {
      if (read.has(Number(item.getAttribute("data-id")))) item.classList.add("is-read");
    });

    var total = Number(body.getAttribute("data-total")) || 0;
    var progress = document.querySelector("[data-read-progress]");
    if (progress && read.size > 0) {
      progress.textContent = "읽은 글 " + read.size + " / " + total + "편";
    }

    var last = load(author + ":last", null);
    var resume = document.querySelector("[data-resume]");
    if (resume && last && last.id) {
      resume.href = last.id + ".html";
      resume.textContent = "이어 읽기: " + (last.title.length > 22 ? last.title.slice(0, 22) + "…" : last.title);
      resume.hidden = false;
      var current = document.querySelector(".toc-list li[data-id='" + last.id + "']");
      if (current) current.classList.add("is-current");
    }

    // 주소에 #toc-글번호가 있으면 접혀 있는 부록도 펼쳐서 보여 준다.
    if (location.hash) {
      var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) {
        var fold = target.closest("details");
        if (fold) fold.open = true;
        target.scrollIntoView({ block: "center" });
      }
    }

    var search = document.querySelector(".toc-search");
    var count = document.querySelector(".toc-count");
    if (!search) return;
    search.addEventListener("input", function () {
      var query = search.value.trim().toLowerCase();
      var shown = 0;
      items.forEach(function (item) {
        var text = (item.getAttribute("data-search") || item.textContent).toLowerCase();
        var hit = !query || text.indexOf(query) !== -1;
        if (hit) {
          item.removeAttribute("data-search-hidden");
          shown += 1;
        } else {
          item.setAttribute("data-search-hidden", "");
        }
      });
      document.querySelectorAll("[data-search-group]").forEach(function (group) {
        var visible = group.querySelector(".toc-list li[data-id]:not([data-search-hidden])");
        if (visible) group.removeAttribute("data-search-hidden");
        else group.setAttribute("data-search-hidden", "");
        if (query && visible && group.tagName === "DETAILS") group.open = true;
      });
      if (count) count.textContent = query ? "찾은 글 " + shown + "편" : "";
    });
  }

  /* ---------- 서재 화면 ---------- */

  function setupLibrary() {
    document.querySelectorAll("[data-book]").forEach(function (card) {
      var slug = card.getAttribute("data-book");
      var total = Number(card.getAttribute("data-total")) || 0;
      var read = readSet(slug);
      var progress = card.querySelector("[data-read-progress]");
      if (progress && read.size > 0) progress.textContent = "읽은 글 " + read.size + " / " + total + "편";
      var last = load(slug + ":last", null);
      var resume = card.querySelector("[data-resume]");
      if (resume && last && last.id) {
        resume.href = slug + "/" + last.id + ".html";
        resume.hidden = false;
      }
    });
  }

  var page = body.getAttribute("data-page");
  if (page === "article") setupArticle();
  if (page === "toc" || page === "months") setupToc();
  if (page === "library") setupLibrary();
})();
