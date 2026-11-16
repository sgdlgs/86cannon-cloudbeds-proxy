/*
 * 86 Cannon booking panel — Webflow bridge.
 *
 * Unlike the generic booking-widget-lib (sgdlgs/booking-widget-lib), this
 * file is NOT a shared multi-engine library. It is written specifically for
 * 86 Cannon's Cloudbeds Immersive Overlay handoff, which a hidden-form GET
 * redirect can't express (same-page custom-element click, not a redirect —
 * see openCloudbedsOverlay below). If another property needs this later,
 * copy this file and adjust; don't generalize it back into the shared lib.
 *
 * Like that library, this script builds its own .bw-overlay/.bw-panel-wrap/
 * .bw-panel DOM from scratch at runtime and relies entirely on Webflow's
 * published CSS for styling — the "Booking Panel — Style Demo" section on
 * the /cloudbeds-overlay page exists ONLY to force Webflow to publish a CSS
 * rule for every bw-* class used here; this script never reads or touches
 * that section's own elements.
 *
 * Any element anywhere on the site with [data-book-trigger] opens the
 * panel. Optional data-room-id / data-room-name / data-room-sleeps /
 * data-room-type attributes on that trigger attach a specific room.
 */
(function () {
  "use strict";

  // ============================================================
  // CLOUDBEDS OVERLAY — hands off to Cloudbeds' own "Immersive
  // Experience" booking overlay (the <cb-book-now-button> custom element
  // Cloudbeds' loader script defines) rather than opening a new tab.
  // Search writes the picked dates/guests/room onto the page's own URL via
  // history.pushState (confirmed the overlay re-reads the URL at open
  // time, not just once on page load), then clicks a hidden instance of
  // Cloudbeds' own button — so the guest sees one continuous panel-to-panel
  // handoff instead of two disconnected widgets.
  //
  // Param names (checkin/checkout/guests/accommodation_types) come from
  // reading Cloudbeds' own shipped bundle (usePageNavigation.chunk.js), not
  // their docs (paywalled) — verified live against
  // https://www.86cannon.com/cloudbeds-overlay.
  //
  // Cloudbeds enforces CORS on an allow-listed-domain basis for the
  // overlay's own data calls — it opens and runs the handoff from
  // anywhere, but only loads real room/rate data from a domain added to
  // this property's allowed domains in Cloudbeds' settings. localhost
  // shows a loading error even when everything here is correct.
  // ============================================================
  var CLOUDBEDS_PROPERTY_CODE = "1VTW33";
  var CLOUDBEDS_LOADER_SRC = "https://static1.cloudbeds.com/booking-engine/latest/loader.js";

  // ============================================================
  // RATES CONFIG — live per-day "from" rates and sold-out days on the
  // calendar, pulled from a small proxy in front of Cloudbeds' API (the
  // API key can't live in this file — see cloudbeds-rate-proxy/README.md).
  //
  //   enabled    master switch. false = calendar behaves exactly as before
  //              (dates only, no price labels, nothing else disabled).
  //   proxyUrl   the proxy's /api/rates endpoint.
  //
  // roomId is sent automatically when a room is attached (room pages) and
  // omitted for the header's general "Book Now".
  // ============================================================
  var RATES = {
    enabled: true,
    proxyUrl: "https://86cannon-cloudbeds.vercel.app/api/rates"
  };
  var USE_MOCK_RATES = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  var STORAGE_KEY = "cbWidgetSelection";
  var MIN_GUESTS = 1;
  // Every room at 86 Cannon is a single king sleeping 2 — the property
  // takes no children and no pets. If that ever changes, this file (not
  // booking-widget-lib) is where the children/pets rows would come back.
  var ALLOW_CHILDREN = false;
  var DEFAULT_ROOM_NOUN = "room";
  var MAX_GUESTS = 2;
  var MAX_MONTHS_AHEAD = 18;

  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTH_FMT = { month: "long", year: "numeric" };

  var state = {
    roomId: null,
    roomLabel: null,
    roomMaxGuests: null,
    roomNoun: null,
    // Filled in from the rates response (thumbnailUrl) once a room-scoped
    // fetch resolves — see fetchRatesForMonth. Not sourced from the
    // trigger's data-* attributes; those don't carry an image.
    roomThumbUrl: null,
    checkin: null,
    checkout: null,
    adults: 2,
    calendarMonth: startOfMonth(new Date()),
    hoverPreview: null,
    // Rate/availability responses keyed by "<YYYY-MM>|<roomId|all>", so
    // flipping back to a previously-viewed month or room doesn't refetch.
    rateCache: {},
    rangeUnavailable: false
  };

  var els = {};

  // ============================================================
  // TIDIO — the site's chat widget (code.tidio.co script in Site Head
  // Code) renders its own fixed, very-high-z-index launcher icon that sits
  // above everything, our panel included, and overlaps its footer on both
  // mobile and desktop. Tidio's widget is a cross-origin iframe, so fighting
  // it with CSS/z-index isn't reliable — Tidio's own JS API (hide()/show())
  // is the supported way to toggle it.
  //
  // window.tidioChatApi can still be undefined by the time a guest opens
  // the panel (Tidio's own script loads async and bootstraps further after
  // that). Checked directly, live, at call time rather than gated behind
  // Tidio's "tidioChat-ready" event: that event only fires once, and since
  // this script runs from Footer Code — after Tidio's Head Code script —
  // it can easily miss that single firing and be permanently stuck
  // "not ready" even once the API exists. Polling window.tidioChatApi's
  // own presence has no such race.
  // ============================================================
  var pendingTidioVisible = null;
  var tidioPollTimer = null;

  function applyTidioVisibility(visible) {
    if (visible) {
      window.tidioChatApi.show();
    } else {
      window.tidioChatApi.hide();
    }
  }

  function pollForTidio() {
    if (tidioPollTimer) return;
    tidioPollTimer = setInterval(function () {
      if (!window.tidioChatApi) return;
      clearInterval(tidioPollTimer);
      tidioPollTimer = null;
      if (pendingTidioVisible !== null) {
        applyTidioVisibility(pendingTidioVisible);
        pendingTidioVisible = null;
      }
    }, 250);
  }

  function setTidioVisible(visible) {
    if (window.tidioChatApi) {
      applyTidioVisibility(visible);
    } else {
      pendingTidioVisible = visible;
      pollForTidio();
    }
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function toISO(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function fromISO(str) {
    var parts = str.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  // Cloudbeds stops accepting today as a brand-new check-in date at 2pm
  // property-local time, even though the room's own inventory
  // (getRatePlans) keeps reporting today as available all day long —
  // confirmed live against the real Cloudbeds overlay. This cutoff is the
  // booking engine's own business rule, not something the rates API
  // exposes, so it has to be applied independently here, and specifically
  // against the PROPERTY's local clock (Charleston, SC), not the guest's
  // browser timezone — a guest browsing from across the country sees the
  // same cutoff Cloudbeds itself would apply to them.
  var PROPERTY_TIMEZONE = "America/New_York";
  var SAME_DAY_CUTOFF_HOUR = 14; // 2:00 PM property-local time

  function propertyNow() {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: PROPERTY_TIMEZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false
    }).formatToParts(new Date());
    function get(type) {
      var match = parts.filter(function (p) { return p.type === type; })[0];
      return match ? parseInt(match.value, 10) : 0;
    }
    var hour = get("hour");
    if (hour === 24) hour = 0; // some runtimes report midnight as "24"
    return { date: new Date(get("year"), get("month") - 1, get("day")), hour: hour };
  }

  // The earliest date selectable as a NEW check-in right now. Equal to the
  // property's local "today" normally; bumped to tomorrow once the
  // same-day cutoff has passed — at that point today behaves exactly like
  // a past date: not valid as a check-in or a middle night, and (since
  // checkout always falls after check-in) never reachable as a checkout
  // either, so no separate "but allow it as checkout" case is needed.
  function minSelectableCheckin() {
    var now = propertyNow();
    return now.hour >= SAME_DAY_CUTOFF_HOUR
      ? new Date(now.date.getFullYear(), now.date.getMonth(), now.date.getDate() + 1)
      : now.date;
  }

  function addMonths(date, n) {
    return new Date(date.getFullYear(), date.getMonth() + n, 1);
  }

  function sameDay(a, b) {
    return a && b && a.getTime() === b.getTime();
  }

  function formatShort(date) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function formatRate(n) {
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function nightsBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }

  // Property-wide stay policy (not tied to availability data, so it applies
  // identically to every room and the general search): Charleston is a
  // weekend market, so a short stay touching Friday or Saturday night has to
  // cover both of them — no lone Friday-only or Saturday-only booking. A
  // stay of 3+ nights is exempt entirely. Per the owner: "I want to tie
  // Friday and Saturday together... but if you stay three days, that rule
  // trumps."
  function violatesWeekendPairing(checkin, checkout) {
    if (nightsBetween(checkin, checkout) >= 3) return false;

    var touchesFriday = false;
    var touchesSaturday = false;
    var cursor = new Date(checkin.getFullYear(), checkin.getMonth(), checkin.getDate());
    while (cursor < checkout) {
      var weekday = cursor.getDay();
      if (weekday === 5) touchesFriday = true;
      if (weekday === 6) touchesSaturday = true;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }

    if (!touchesFriday && !touchesSaturday) return false;
    return !(touchesFriday && touchesSaturday);
  }

  // Tried (2026-11-16) matching our own remembered-dates TTL to Cloudbeds'
  // 10-minute quote cache, on the theory that replaying stale remembered
  // dates was what triggered Cloudbeds' "session timed out" base screen.
  // Reverted after live testing proved that theory wrong: the base-screen
  // fallback reproduces identically regardless of whether the dates came
  // from this storage or were just freshly clicked in our own calendar —
  // it's driven purely by how long it's been since Cloudbeds' OWN widget
  // last fetched anything in this tab (its own session/auth token idling
  // out), not by anything in our storage. Expiring our copy only added
  // friction (forcing a guest to retype dates we could've kept) with zero
  // effect on the actual symptom. See the "Cloudbeds stale-room limitation"
  // memory — this is the same family of issue (Cloudbeds' own persisted
  // state only properly refreshes on a full page reload) and is likewise
  // not fixable from this side short of that.
  function loadSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data.checkin || !data.checkout) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function saveSession() {
    if (!state.checkin || !state.checkout) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        checkin: toISO(state.checkin),
        checkout: toISO(state.checkout),
        adults: state.adults
      }));
    } catch (e) { /* storage unavailable — widget still works, just won't persist */ }
  }

  // ============================================================
  // PANEL SHELL — built to match the exact class structure published on
  // the "Booking Panel — Style Demo" Webflow section, not the older
  // generic layout. Two differences worth flagging since they look like
  // bugs if you're used to the older prototype:
  //
  //   1. Close is a text pill ("CLOSE") sitting ABOVE the panel, not an ×
  //      icon inside the header — that's Figma's actual design, not a
  //      simplification.
  //   2. .bw-room-chip-wrap and .bw-availability-warning are both toggled
  //      via the `hidden` attribute while also carrying `display: flex`
  //      from their own published class — the class rule's specificity
  //      beats the browser's native `[hidden] { display: none }` rule, so
  //      `hidden` alone does nothing on these two. See the Head Code
  //      override this project's CLAUDE.md documents; don't try to "fix"
  //      this by adding a stronger inline style here instead.
  // ============================================================
  function buildPanel() {
    var overlay = document.createElement("div");
    overlay.className = "bw-overlay";

    var panelWrap = document.createElement("div");
    panelWrap.className = "bw-panel-wrap";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "bw-close-btn";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = '<span class="bw-close-text">CLOSE</span>';

    var panel = document.createElement("div");
    panel.className = "bw-panel";
    panel.innerHTML =
      '<div class="bw-panel-header">' +
        '<div class="bw-panel-header-title">Check Availability</div>' +
      "</div>" +
      '<div class="bw-panel-body">' +
        '<div class="bw-calendar-loader"><div class="bw-calendar-spinner"></div></div>' +
        '<div class="bw-room-chip-wrap" hidden></div>' +
        '<div class="bw-calendar">' +
          '<div class="bw-cal-nav">' +
            '<button type="button" class="bw-cal-prev" aria-label="Previous month">' +
              '<svg width="8" height="14" viewBox="0 0 8 14" fill="none"><path d="M7 1L1 7L7 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            "</button>" +
            '<h3 class="bw-cal-month"></h3>' +
            '<button type="button" class="bw-cal-next" aria-label="Next month">' +
              '<svg width="8" height="14" viewBox="0 0 8 14" fill="none"><path d="M1 1L7 7L1 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            "</button>" +
          "</div>" +
          '<div class="bw-weekdays"></div>' +
          '<div class="bw-days"></div>' +
        "</div>" +
        '<div class="bw-hr"><div class="bw-hr-rule"></div></div>' +
        '<div class="bw-guests">' +
          '<div class="bw-guest-row bw-adults-row" aria-describedby="bw-guest-warning">' +
            '<div class="bw-guest-text">' +
              '<span class="bw-guest-label">Adults</span>' +
              '<span class="bw-guest-sublabel">Ages 18 or above</span>' +
            "</div>" +
            '<div class="bw-stepper">' +
              '<button type="button" class="bw-stepper-btn bw-guest-minus" aria-label="Fewer adults"><span class="bw-stepper-symbol">−</span></button>' +
              '<span class="bw-count">2</span>' +
              '<button type="button" class="bw-stepper-btn bw-guest-plus" aria-label="More adults"><span class="bw-stepper-symbol">+</span></button>' +
            "</div>" +
          "</div>" +
          '<p class="bw-guest-warning" id="bw-guest-warning" role="status" hidden></p>' +
        "</div>" +
      "</div>" +
      '<div class="bw-panel-footer">' +
        // Lives in the pinned footer, not the scrollable calendar area,
        // so a short viewport can't scroll it out of view the way it
        // could while nested inside .bw-calendar — same reasoning as
        // .bw-availability-warning just below.
        '<p class="bw-stay-rule-notice" role="status" hidden>Friday &amp; Saturday nights must be booked together, or stay 3+ nights.</p>' +
        '<div class="bw-availability-warning" role="status" hidden>' +
          '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
            '<circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.4"/>' +
            '<rect x="9.25" y="8.5" width="1.5" height="5.5" rx="0.75" fill="currentColor"/>' +
            '<rect x="9.25" y="5.5" width="1.5" height="1.5" rx="0.75" fill="currentColor"/>' +
          "</svg>" +
          '<p class="bw-availability-warning-text">This room is not available on those dates. Try selecting another room or different dates.</p>' +
          '<button type="button" class="bw-availability-warning-close" aria-label="Dismiss">' +
            '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M1 1L17 17M17 1L1 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
          "</button>" +
        "</div>" +
        '<div class="bw-footer-inner">' +
          '<div class="bw-hint-wrap"><p class="bw-hint">Select dates to check availability</p></div>' +
          '<button type="button" class="bw-submit" disabled><span class="bw-submit-text">Search</span></button>' +
        "</div>" +
      "</div>";

    panelWrap.appendChild(closeBtn);
    panelWrap.appendChild(panel);

    document.body.appendChild(overlay);
    document.body.appendChild(panelWrap);

    els.overlay = overlay;
    els.panelWrap = panelWrap;
    els.panel = panel;
    els.close = closeBtn;
    els.roomChipWrap = panel.querySelector(".bw-room-chip-wrap");
    els.calendarLoader = panel.querySelector(".bw-calendar-loader");
    els.calendar = panel.querySelector(".bw-calendar");
    els.monthLabel = panel.querySelector(".bw-cal-month");
    els.prevBtn = panel.querySelector(".bw-cal-prev");
    els.nextBtn = panel.querySelector(".bw-cal-next");
    els.weekdays = panel.querySelector(".bw-weekdays");
    els.days = panel.querySelector(".bw-days");
    els.stayRuleNotice = panel.querySelector(".bw-stay-rule-notice");
    var adultsRow = panel.querySelector(".bw-adults-row");
    els.guestMinus = adultsRow.querySelector(".bw-guest-minus");
    els.guestPlus = adultsRow.querySelector(".bw-guest-plus");
    els.guestCount = adultsRow.querySelector(".bw-count");
    els.guestWarning = panel.querySelector(".bw-guest-warning");
    els.availabilityWarning = panel.querySelector(".bw-availability-warning");
    els.availabilityWarningClose = els.availabilityWarning.querySelector(".bw-availability-warning-close");
    els.hintWrap = panel.querySelector(".bw-hint-wrap");
    els.submit = panel.querySelector(".bw-submit");
    els.submitText = els.submit.querySelector(".bw-submit-text");

    WEEKDAYS.forEach(function (d) {
      var span = document.createElement("span");
      span.className = "bw-weekday-text";
      span.textContent = d;
      var wrap = document.createElement("div");
      wrap.className = "bw-weekday";
      wrap.appendChild(span);
      els.weekdays.appendChild(wrap);
    });

    // Wrapped, not passed directly: addEventListener hands the click Event
    // to the listener, which would otherwise land in closePanel's own
    // keepTidioHidden parameter and suppress restoring Tidio on every
    // close-button/backdrop click.
    els.close.addEventListener("click", function () { closePanel(); });
    els.overlay.addEventListener("click", function () { closePanel(); });
    // .bw-panel-wrap spans the full height so a short panel can centre in
    // it. Clicks landing on the wrap itself (the gap above/below the
    // panel) should close, same as clicking the backdrop.
    els.panelWrap.addEventListener("click", function (e) {
      if (e.target === els.panelWrap) closePanel();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && els.panelWrap.classList.contains("is-open")) closePanel();
    });

    els.days.addEventListener("mouseleave", clearHoverPreview);

    els.prevBtn.addEventListener("click", function () {
      if (els.prevBtn.disabled) return;
      state.calendarMonth = addMonths(state.calendarMonth, -1);
      renderCalendar();
    });
    els.nextBtn.addEventListener("click", function () {
      if (els.nextBtn.disabled) return;
      state.calendarMonth = addMonths(state.calendarMonth, 1);
      renderCalendar();
    });

    els.guestMinus.addEventListener("click", function () {
      setAdults(state.adults - 1);
    });
    els.guestPlus.addEventListener("click", function () {
      setAdults(state.adults + 1);
    });

    els.submit.addEventListener("click", function () {
      if (els.submit.disabled) return;
      saveSession();
      // Keep our panel on screen (no slide-out) until Cloudbeds' overlay
      // has actually mounted in the same spot, then drop ours instantly —
      // see closePanelInstant() and openCloudbedsOverlay() for why.
      openCloudbedsOverlay(closePanelInstant);
    });

    // Dismisses the banner itself, not the problem — the room is still
    // unavailable for these dates, so Search stays disabled. A fresh
    // openPanel() (or dates/room changing again) re-evaluates and can show
    // it again.
    els.availabilityWarningClose.addEventListener("click", function () {
      els.availabilityWarning.hidden = true;
    });
  }

  function setAdults(n) {
    state.adults = Math.max(MIN_GUESTS, Math.min(MAX_GUESTS, n));
    renderGuests();
    renderFooterInfo();
    if (state.checkin && state.checkout) saveSession();
  }

  // Ceiling that applies right now: the attached room's capacity when
  // there is one, otherwise the property's.
  function maxGuestsForContext() {
    return Math.min(MAX_GUESTS, state.roomMaxGuests || MAX_GUESTS);
  }

  function roomNoun() {
    return (state.roomNoun || DEFAULT_ROOM_NOUN).toLowerCase();
  }

  function totalOccupancy() {
    return state.adults;
  }

  function renderGuests() {
    var contextMax = maxGuestsForContext();
    var occupancy = totalOccupancy();

    els.guestCount.textContent = state.adults;
    els.guestMinus.disabled = state.adults <= MIN_GUESTS;
    els.guestPlus.disabled = occupancy >= contextMax;

    // Two distinct jobs, which is why the disabled "+" alone isn't enough.
    // AT capacity the message explains why "+" is dead. OVER capacity —
    // only reachable by arriving from a bigger room via sessionStorage —
    // says what to do about it. Neither fires without a room attached: the
    // header's general "Book Now" has no capacity to speak about.
    var atCapacity = !!state.roomMaxGuests && occupancy === state.roomMaxGuests;
    var overCapacity = !!state.roomMaxGuests && occupancy > state.roomMaxGuests;

    els.guestWarning.hidden = !(atCapacity || overCapacity);
    els.guestWarning.classList.toggle("is-warning", overCapacity);
    if (overCapacity) {
      els.guestWarning.textContent =
        "This " + roomNoun() + " sleeps " + state.roomMaxGuests + " — reduce guests to continue.";
    } else if (atCapacity) {
      els.guestWarning.textContent = "This " + roomNoun() + " sleeps " + state.roomMaxGuests + ".";
    }
  }

  function renderRoomChip() {
    if (!state.roomLabel) {
      els.roomChipWrap.hidden = true;
      els.roomChipWrap.innerHTML = "";
      return;
    }

    els.roomChipWrap.hidden = false;
    els.roomChipWrap.innerHTML =
      '<div class="bw-room-chip">' +
        // Omitted (not an empty/broken <img>) until a thumbnail actually
        // arrives from the rates response — see fetchRatesForMonth.
        (state.roomThumbUrl
          ? '<div class="bw-room-chip-visual"><img class="bw-room-chip-img" src="' + state.roomThumbUrl + '" alt="' + state.roomLabel + '"></div>'
          : "") +
        '<div class="bw-room-chip-text">' +
          '<span class="bw-room-chip-label">Selected room</span>' +
          '<span class="bw-room-chip-name">' + state.roomLabel + "</span>" +
        "</div>" +
        '<button type="button" class="bw-room-chip-remove">Remove</button>' +
      "</div>";

    els.roomChipWrap.querySelector(".bw-room-chip-remove").addEventListener("click", function () {
      // Detaches the room without closing the panel — falls back to a
      // general search. Dates/guests already picked are kept; only the
      // room-specific ceiling and rate scoping go away.
      state.roomId = null;
      state.roomLabel = null;
      state.roomMaxGuests = null;
      state.roomNoun = null;
      state.roomThumbUrl = null;
      renderRoomChip();
      renderGuests();
      renderCalendar();
      updateSubmitState();
      updateAvailabilityWarning();
    });
  }

  // The footer's left side is either a single hint line (no dates yet) or
  // two Dates/Guests recap blocks — swapped wholesale, same approach as
  // renderRoomChip. No explicit "clear dates" control: picking a new day
  // after a complete range already starts a fresh one (see selectDate).
  function renderFooterInfo() {
    var hasDates = state.checkin && state.checkout;

    if (!hasDates) {
      els.hintWrap.innerHTML = '<p class="bw-hint">Select dates to check availability</p>';
      return;
    }

    var nights = nightsBetween(state.checkin, state.checkout);
    els.hintWrap.innerHTML =
      '<div class="bw-summary">' +
        '<span class="bw-summary-label">Dates</span>' +
        '<span class="bw-summary-value">' + formatShort(state.checkin) + " – " + formatShort(state.checkout) + "</span>" +
        '<span class="bw-summary-sub">' + nights + (nights === 1 ? " night" : " nights") + "</span>" +
      "</div>" +
      '<div class="bw-summary">' +
        '<span class="bw-summary-label">Guests</span>' +
        '<span class="bw-summary-value">' + totalOccupancy() + "</span>" +
      "</div>";
  }

  // Builds one calendar cell. Cells outside the visible month (the tail of
  // the previous month / the head of the next) render as real adjacent-
  // month dates — not blank filler divs — and get the exact same
  // availability/pricing/selection treatment as any other day, since
  // they're genuinely bookable dates, just rendered to fill out the grid.
  // dataset.adjacent is kept only as a "which month is this" marker (e.g.
  // for future styling); it no longer forces a disabled/unavailable look.
  function buildDayCell(date, inCurrentMonth, today, minSelectable) {
    var cell = document.createElement("div");
    cell.className = "bw-day-cell";
    cell.dataset.iso = toISO(date);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bw-day";

    var numSpan = document.createElement("span");
    numSpan.className = "bw-day-num";
    numSpan.textContent = date.getDate();
    btn.appendChild(numSpan);

    if (RATES.enabled) {
      var priceSpan = document.createElement("span");
      priceSpan.className = "bw-day-price";
      btn.appendChild(priceSpan);
    }

    cell.appendChild(btn);

    if (!inCurrentMonth) btn.dataset.adjacent = "true";

    if (sameDay(date, today)) btn.classList.add("is-today");

    var isPast = date < minSelectable;
    if (isPast) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", function (clickedDate) {
        return function () { selectDate(clickedDate); };
      }(date));
      // Only touches classList — never rebuilds the DOM. Rebuilding the
      // node under the cursor mid-hover breaks the click that follows: the
      // browser re-resolves the hover target on mousedown, which would
      // trigger another rebuild between mousedown and mouseup, leaving
      // click with no consistent target to fire on.
      btn.addEventListener("mouseenter", function (hoveredDate, dayBtn) {
        return function () {
          // A sold-out day can still carry a mouseenter listener (only
          // past dates are excluded up front, before rate data exists) —
          // guard here so hovering one can't preview a range through it.
          if (dayBtn.disabled) return;
          setHoverPreview(hoveredDate);
        };
      }(date, btn));
    }

    return cell;
  }

  function renderCalendar() {
    var today = propertyNow().date;
    var minSelectable = minSelectableCheckin();
    var year = state.calendarMonth.getFullYear();
    var month = state.calendarMonth.getMonth();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var startWeekday = new Date(year, month, 1).getDay();

    els.monthLabel.textContent = state.calendarMonth.toLocaleDateString("en-US", MONTH_FMT);

    var minMonth = startOfMonth(today);
    var atMinMonth = state.calendarMonth <= minMonth;
    els.prevBtn.disabled = atMinMonth;
    els.prevBtn.classList.toggle("is-disabled", atMinMonth);

    var maxMonth = addMonths(minMonth, MAX_MONTHS_AHEAD);
    var atMaxMonth = state.calendarMonth >= maxMonth;
    els.nextBtn.disabled = atMaxMonth;
    els.nextBtn.classList.toggle("is-disabled", atMaxMonth);

    els.days.innerHTML = "";

    // Leading cells: the tail end of the previous month.
    var prevMonthLastDate = new Date(year, month, 0).getDate();
    var leadCount = startWeekday;
    for (var lead = leadCount; lead > 0; lead--) {
      var leadDate = new Date(year, month - 1, prevMonthLastDate - lead + 1);
      els.days.appendChild(buildDayCell(leadDate, false, today, minSelectable));
    }

    // Current month.
    for (var d = 1; d <= daysInMonth; d++) {
      els.days.appendChild(buildDayCell(new Date(year, month, d), true, today, minSelectable));
    }

    // Trailing cells: pad out to a full row (multiple of 7), from the
    // head of the next month.
    var totalSoFar = startWeekday + daysInMonth;
    var trailCount = (7 - (totalSoFar % 7)) % 7;
    for (var t = 1; t <= trailCount; t++) {
      els.days.appendChild(buildDayCell(new Date(year, month + 1, t), false, today, minSelectable));
    }

    applyRangeHighlight();

    // Hides everything in the body and footer behind a spinner for any
    // month whose rates aren't already cached, so nothing — room chip,
    // grid, guests, Search — is shown half-settled before the real state
    // is in. Matches the loading moment Cloudbeds' own overlay shows.
    // Rates-off sites never show a spinner at all: the panel is the whole
    // story there, same as before this existed.
    if (RATES.enabled) {
      var key = rateCacheKey(state.calendarMonth, state.roomId);
      var cached = state.rateCache[key];
      els.panel.classList.toggle("is-loading-rates", !(cached && !cached.loading));
      fetchRatesForVisibleMonth();

      // Leading/trailing cells belong to the adjacent month, so their
      // availability needs that month's own rate data too — fetched
      // separately from the visible month (which drives the loading
      // spinner above) so those cells repaint as soon as it resolves,
      // without holding up the rest of the panel.
      if (leadCount > 0) fetchRatesForMonth(addMonths(state.calendarMonth, -1), applyRangeHighlight);
      if (trailCount > 0) fetchRatesForMonth(addMonths(state.calendarMonth, 1), applyRangeHighlight);
    } else {
      els.panel.classList.remove("is-loading-rates");
    }
  }

  function computeRangeFlags(date) {
    var previewCheckout = null;
    if (state.checkin && !state.checkout && state.hoverPreview && state.hoverPreview > state.checkin) {
      previewCheckout = state.hoverPreview;
    }
    var effectiveCheckout = state.checkout || previewCheckout;
    return {
      isStart: sameDay(date, state.checkin),
      isEnd: sameDay(date, effectiveCheckout),
      inRange: !!(state.checkin && effectiveCheckout && date > state.checkin && date < effectiveCheckout)
    };
  }

  function rateCacheKey(monthDate, roomId) {
    return monthDate.getFullYear() + "-" + pad2(monthDate.getMonth() + 1) + "|" + (roomId || "all");
  }

  // Looks up a single day's cached availability, regardless of which month
  // is currently visible — the range check below may span a month
  // boundary. Returns null for a month not yet fetched (or still
  // fetching), which callers treat as "unknown, assume available" rather
  // than blocking a selection we can't verify.
  function getCachedDayInfo(date) {
    var key = rateCacheKey(startOfMonth(date), state.roomId);
    var entry = state.rateCache[key];
    if (!entry || entry.loading) return null;
    return entry.days[toISO(date)] || null;
  }

  // True if any night strictly between a and b is known sold out — i.e. b
  // isn't a valid checkout for a stay starting at a.
  function rangeHasUnavailableDay(a, b) {
    if (!RATES.enabled) return false;
    var cursor = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1);
    while (cursor < b) {
      var info = getCachedDayInfo(cursor);
      if (info && info.available === false) return true;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    return false;
  }

  // Fetches one month's rates/availability (scoped to the attached room, if
  // any) into state.rateCache, de-duping against both a warm cache entry
  // and an in-flight request for the same (month, room).
  function fetchRatesForMonth(monthDate, onDone) {
    var key = rateCacheKey(monthDate, state.roomId);
    var cached = state.rateCache[key];

    if (cached) {
      if (cached.loading) {
        if (onDone) {
          cached.waiters = cached.waiters || [];
          cached.waiters.push(onDone);
        }
      } else {
        // A warm cache entry short-circuits before the fresh-fetch .then()
        // below ever runs, so the thumbnail has to be re-applied here too —
        // otherwise a room whose rates are already cached from earlier in
        // the session (e.g. re-selected after Remove, or just reopened)
        // keeps whatever (or no) thumbnail was showing, forever. This runs
        // synchronously, so state.roomId is already the current room —
        // no staleness check needed like the async path below has.
        if (cached.thumbnailUrl && cached.thumbnailUrl !== state.roomThumbUrl) {
          state.roomThumbUrl = cached.thumbnailUrl;
          renderRoomChip();
        }
        if (onDone) onDone();
      }
      return;
    }

    var monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    var monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
    var requestRoomId = state.roomId;
    var url = RATES.proxyUrl +
      "?start=" + toISO(monthStart) +
      "&end=" + toISO(monthEnd) +
      (requestRoomId ? "&roomId=" + encodeURIComponent(requestRoomId) : "") +
      (USE_MOCK_RATES ? "&mock=1" : "");

    var entry = { days: {}, loading: true, waiters: onDone ? [onDone] : [] };
    state.rateCache[key] = entry;

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("rates http " + res.status);
        return res.json();
      })
      .then(function (data) {
        entry.days = data.days || {};
        entry.thumbnailUrl = data.thumbnailUrl || null;
        entry.loading = false;
        var waiters = entry.waiters || [];
        delete entry.waiters;
        // The room may have changed (or been detached) while this was in
        // flight — only adopt the thumbnail if it's still for the room
        // actually attached now, and only repaint the chip when it's new.
        if (data.thumbnailUrl && requestRoomId && requestRoomId === state.roomId &&
            data.thumbnailUrl !== state.roomThumbUrl) {
          state.roomThumbUrl = data.thumbnailUrl;
          renderRoomChip();
        }
        // The user may have navigated to a different month/room while this
        // was in flight — only touch the DOM if it's still what's showing.
        if (rateCacheKey(state.calendarMonth, state.roomId) === key) {
          applyRangeHighlight();
          els.panel.classList.remove("is-loading-rates");
        }
        waiters.forEach(function (fn) { fn(); });
      })
      .catch(function () {
        // Degrade silently: no price labels, nothing extra disabled. The
        // panel already works fine on dates alone — reveal it rather than
        // leaving the spinner stuck up with nothing coming.
        var waiters = entry.waiters || [];
        delete state.rateCache[key];
        if (rateCacheKey(state.calendarMonth, state.roomId) === key) {
          els.panel.classList.remove("is-loading-rates");
        }
        waiters.forEach(function (fn) { fn(); });
      });
  }

  function fetchRatesForVisibleMonth() {
    var key = rateCacheKey(state.calendarMonth, state.roomId);
    var cached = state.rateCache[key];
    if (cached && !cached.loading) {
      applyRangeHighlight();
      return;
    }
    fetchRatesForMonth(state.calendarMonth, null);
  }

  function monthsBetween(a, b) {
    var months = [];
    var cursor = startOfMonth(a);
    var end = startOfMonth(b);
    while (cursor <= end) {
      months.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    return months;
  }

  // Re-checks whether the currently selected checkin/checkout range is
  // still bookable in whatever scope is now attached. Needed because dates
  // persist across pages via sessionStorage, so a guest can arrive at a
  // room page with dates that were fine for a different room, or the
  // general search, but aren't available for this one. Fetches whichever
  // months it doesn't have cached data for yet and re-runs itself once
  // those arrive — until then the range is treated as available (same
  // fail-open rule as rangeHasUnavailableDay).
  function updateAvailabilityWarning() {
    if (!RATES.enabled || !state.checkin || !state.checkout) {
      setRangeUnavailable(false);
      return;
    }

    var pending = false;
    monthsBetween(state.checkin, state.checkout).forEach(function (m) {
      var key = rateCacheKey(m, state.roomId);
      var cached = state.rateCache[key];
      if (!cached || cached.loading) {
        pending = true;
        fetchRatesForMonth(m, updateAvailabilityWarning);
      }
    });
    if (pending) return;

    var unavailable = false;
    var cursor = startOfDay(state.checkin);
    while (cursor < state.checkout) {
      var info = getCachedDayInfo(cursor);
      if (info && info.available === false) {
        unavailable = true;
        break;
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }

    setRangeUnavailable(unavailable);
  }

  function setRangeUnavailable(unavailable) {
    state.rangeUnavailable = unavailable;
    els.availabilityWarning.hidden = !unavailable;
    updateSubmitState();
  }

  // Single authoritative pass over the day cells already in the DOM —
  // active-range highlighting, rate/availability display, and (new)
  // checkout-reachability all live here together, in this order, so later
  // rules can see and override earlier ones on the same pass. Previously
  // rate display was a separate applyRateDisplay() function, but it and
  // this one both decide a cell's disabled state from the same facts, and
  // whichever ran second silently won — merged into one function instead
  // of trying to keep two call orders in sync. Safe to call mid-hover,
  // and after every rate fetch resolves; see the mouseenter comment in
  // buildDayCell for why non-destructive (classList-only) matters.
  function applyRangeHighlight() {
    var previewCheckout = null;
    if (state.checkin && !state.checkout && state.hoverPreview && state.hoverPreview > state.checkin) {
      previewCheckout = state.hoverPreview;
    }
    var previewBlocked = !!previewCheckout && (
      rangeHasUnavailableDay(state.checkin, previewCheckout) ||
      violatesWeekendPairing(state.checkin, previewCheckout)
    );
    var previewBlockedStayRule = !!previewCheckout && violatesWeekendPairing(state.checkin, previewCheckout);
    // Not "today" despite the name below (matches buildDayCell's isPast) —
    // the same-day 2pm cutoff bumps this to tomorrow once it's passed; see
    // minSelectableCheckin().
    var today = minSelectableCheckin();

    // Checkin picked, checkout not yet — every day that can't actually be
    // the checkout (earlier than checkin, or with a known sold-out night
    // between) is shown unavailable up front, not just once hovered.
    // Matches Cloudbeds' own calendar: picking a start date visibly rules
    // out everything that couldn't be a valid end date for it.
    var pickingCheckout = !!state.checkin && !state.checkout;

    els.days.querySelectorAll(".bw-day-cell[data-iso]").forEach(function (cell) {
      var btn = cell.querySelector(".bw-day");
      var numSpan = cell.querySelector(".bw-day-num");
      var priceSpan = cell.querySelector(".bw-day-price");
      if (!btn) return;

      var date = fromISO(cell.dataset.iso);
      var flags = computeRangeFlags(date);
      // The preview still colors normally even when blocked — the
      // not-allowed cursor set below is what tells the user it can't be
      // picked, not a missing highlight.
      var showAsActive = flags.isStart || flags.isEnd || flags.inRange;

      cell.classList.remove("is-active-start", "is-active-mid", "is-active-end");
      if (showAsActive) {
        if (flags.isStart && flags.isEnd) {
          cell.classList.add("is-active-start", "is-active-end");
        } else if (flags.isStart) {
          cell.classList.add("is-active-start");
        } else if (flags.isEnd) {
          cell.classList.add("is-active-end");
        } else if (flags.inRange) {
          cell.classList.add("is-active-mid");
        }
      }

      // Marks every day across the hovered span (not just the end date)
      // so the not-allowed cursor reads consistently as you move across
      // it, matching the local prototype's range-blocked behavior.
      var inPreviewSpan = !!previewCheckout && date >= state.checkin && date <= previewCheckout;
      btn.classList.toggle("is-range-blocked", previewBlocked && inPreviewSpan);

      // Base availability, independent of the current checkin pick.
      var info = getCachedDayInfo(date);
      var isPast = date < today;
      var soldOut = !!info && info.available === false;

      // A sold-out night only rules a date out as the start of a stay, or
      // as a night in the middle of one — not as the checkout. The guest
      // departs that morning and never occupies that night, so it has to
      // stay clickable in that role. flags.isEnd covers the committed
      // checkout too (pickingCheckout is already false by the render
      // after it's picked), so it doesn't lock back up the moment it's
      // selected.
      var isCheckoutCandidate = (pickingCheckout && !flags.isStart) || flags.isEnd;
      var disabled = isPast || (soldOut && !isCheckoutCandidate);
      btn.disabled = disabled;

      // Not reachable as a checkout from the current checkin (earlier
      // than it, or with a known sold-out night between) — shown
      // unavailable, same as disabled, but the button stays clickable.
      // Clicking one restarts the pick from there as a new checkin (see
      // selectDate) rather than doing nothing: a checkin whose very next
      // night is sold out would otherwise trap the guest, since every
      // later date is an invalid checkout and every earlier date reads
      // unavailable, with no click left that does anything.
      var unreachable = pickingCheckout && !flags.isStart && !disabled &&
        (date < state.checkin || rangeHasUnavailableDay(state.checkin, date));

      // Visual "looks unavailable" treatment — past, sold out (even when
      // still clickable as a checkout), or unreachable as a checkout.
      var looksUnavailable = isPast || soldOut || unreachable;
      cell.classList.toggle("is-disabled", looksUnavailable && !showAsActive);
      numSpan.classList.toggle("is-disabled", looksUnavailable);
      numSpan.classList.toggle("is-available", !looksUnavailable && !showAsActive);

      if (priceSpan) {
        var showRate = !looksUnavailable && info && info.rate != null;
        priceSpan.textContent = showRate ? formatRate(info.rate) : "";
      }
    });

    // A sold-out night already explains itself (the day's struck through),
    // but the weekend-pairing rule isn't visually obvious from the
    // calendar alone — only surface the notice when that's the specific
    // reason this preview is blocked.
    els.stayRuleNotice.hidden = !(previewBlockedStayRule && previewBlocked);
  }

  function setHoverPreview(date) {
    if (!state.checkin || state.checkout) return;
    state.hoverPreview = date;
    applyRangeHighlight();
  }

  function clearHoverPreview() {
    if (!state.hoverPreview) return;
    state.hoverPreview = null;
    applyRangeHighlight();
  }

  function selectDate(date) {
    var pickingCheckout = state.checkin && !state.checkout;

    if (pickingCheckout && sameDay(date, state.checkin)) {
      // Re-clicking the just-picked start date clears it back to no
      // selection, instead of leaving it pinned as checkin with nothing
      // to do — lets a guest back out of a start-date pick without being
      // forced to complete a range first.
      state.checkin = null;
      state.checkout = null;
    } else if (pickingCheckout) {
      var isValidCheckout = date > state.checkin &&
        !rangeHasUnavailableDay(state.checkin, date) &&
        !violatesWeekendPairing(state.checkin, date);

      if (isValidCheckout) {
        state.checkout = date;
      } else {
        // Not reachable as a checkout from the current checkin (earlier
        // than it, or a sold-out night / the weekend-pairing rule stands
        // between) — restart the pick from here as a new checkin instead
        // of a dead click. Without this, a checkin whose very next night
        // is sold out would trap the guest: every later date is an
        // invalid checkout, every earlier date reads unavailable
        // (applyRangeHighlight), and nothing is left to click.
        state.checkin = date;
        state.checkout = null;
      }
    } else {
      // No checkin yet, or a complete range already picked — always
      // starts (or restarts) from here. (Re-clicking checkin while it's
      // the only date picked is handled above instead.)
      state.checkin = date;
      state.checkout = null;
    }

    state.hoverPreview = null;

    renderCalendar();
    renderFooterInfo();
    updateSubmitState();
    updateAvailabilityWarning();

    if (state.checkin && state.checkout) saveSession();
  }

  // Just the Search button's disabled state — there's no form to keep in
  // sync; Search hands off to Cloudbeds' own overlay (see
  // openCloudbedsOverlay) instead of submitting anywhere.
  function updateSubmitState() {
    var hasDates = !!(state.checkin && state.checkout);
    els.submit.disabled = !hasDates || state.rangeUnavailable;
    els.submitText.textContent = "Search";
  }

  // Swaps the Search button into/out of a waiting state while
  // openCloudbedsOverlay() below is waiting on Cloudbeds' loader script —
  // without this the button just sits there looking unresponsive for
  // however long that takes (worst case on a cold cache, see there).
  function setSubmitLoading(isLoading) {
    els.submit.disabled = isLoading;
    els.submitText.textContent = isLoading ? "Loading…" : "Search";
  }

  // Reuses the same spinner already shown elsewhere in this panel while
  // rates load (.bw-calendar-loader/.bw-calendar-spinner), but drives it
  // with a direct !important inline style rather than the "is-loading-
  // rates" class it normally toggles on — that class gets reassigned by
  // unrelated rate-cache logic (see initRateCardPrice) on its own render
  // cycle, which would fight a plain class toggle here. The !important
  // inline style can't be overridden by that, so the two uses can't
  // collide even if both happen to be active at once.
  function setHandoffLoading(isLoading) {
    if (!els.calendarLoader) return;
    if (isLoading) {
      els.calendarLoader.style.setProperty("display", "flex", "important");
    } else {
      els.calendarLoader.style.removeProperty("display");
    }
  }

  function openPanel(roomId, roomLabel, roomMaxGuests, roomNounAttr) {
    state.roomId = roomId || null;
    state.roomLabel = roomId ? (roomLabel || null) : null;
    state.roomMaxGuests = roomId && roomMaxGuests ? parseInt(roomMaxGuests, 10) : null;
    state.roomNoun = roomId ? (roomNounAttr || null) : null;
    // Cleared here (not carried over) so a previous room's photo can't
    // flash before this room's own thumbnail arrives from the rates fetch.
    state.roomThumbUrl = null;

    state.hoverPreview = null;
    // Reset from whatever room/scope was attached last time the panel was
    // open — updateAvailabilityWarning() below re-derives the real value
    // for this room once rate data is in.
    state.rangeUnavailable = false;
    els.availabilityWarning.hidden = true;

    var saved = loadSession();
    if (saved) {
      state.checkin = fromISO(saved.checkin);
      state.checkout = fromISO(saved.checkout);
      state.adults = Math.min(saved.adults || state.adults, MAX_GUESTS);
      state.calendarMonth = startOfMonth(state.checkin);
    } else {
      state.checkin = null;
      state.checkout = null;
      state.calendarMonth = startOfMonth(new Date());
    }

    renderRoomChip();
    renderGuests();
    renderCalendar();
    renderFooterInfo();
    updateSubmitState();
    updateAvailabilityWarning();

    els.overlay.classList.add("is-open");
    els.panelWrap.classList.add("is-open");
    document.body.style.overflow = "hidden";
    setTidioVisible(false);
  }

  // keepTidioHidden: true only for the Cloudbeds handoff below — Cloudbeds'
  // own overlay is taking this same screen space, so restoring Tidio here
  // would just put its icon on top of theirs instead of ours.
  function closePanel(keepTidioHidden) {
    els.overlay.classList.remove("is-open");
    els.panelWrap.classList.remove("is-open");
    document.body.style.overflow = "";
    if (!keepTidioHidden) setTidioVisible(true);
  }

  // Same end state as closePanel(), but skips the slide-out transition.
  // Used only for the Cloudbeds handoff: our panel and theirs now occupy
  // the identical screen position, so once theirs has actually mounted,
  // ours should disappear instantly rather than animate out from under it
  // — animating would be visible and read as two panels trading places
  // instead of one continuous panel.
  function closePanelInstant() {
    els.panelWrap.style.transition = "none";
    els.overlay.style.transition = "none";
    void els.panelWrap.offsetHeight; // flush so transition:none applies before the class change below
    closePanel(true);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        els.panelWrap.style.transition = "";
        els.overlay.style.transition = "";
      });
    });
  }

  function wireTriggers() {
    document.querySelectorAll("[data-book-trigger]").forEach(function (trigger) {
      trigger.addEventListener("click", function (e) {
        e.preventDefault();
        openPanel(
          trigger.getAttribute("data-room-id"),
          trigger.getAttribute("data-room-name"),
          trigger.getAttribute("data-room-sleeps"),
          trigger.getAttribute("data-room-type")
        );
      });
    });
  }

  // A room page's rate card shows a static "From $X / night" figure in the
  // markup. Once this room's real rates are in, swap it for the actual
  // lowest available rate over the next 60 days. Runs independently of the
  // booking panel, once per page load, scoped to whichever room this page
  // is for. No-ops on pages with no room attached or no rate card.
  function initRateCardPrice() {
    if (!RATES.enabled) return;

    var trigger = document.querySelector("[data-book-trigger][data-room-id]");
    var amountEl = document.querySelector(".rate-amount .rate-amount-value");
    if (!trigger || !amountEl) return;

    var roomId = trigger.getAttribute("data-room-id");
    var start = startOfDay(new Date());
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 59);
    var url = RATES.proxyUrl +
      "?start=" + toISO(start) +
      "&end=" + toISO(end) +
      "&roomId=" + encodeURIComponent(roomId) +
      (USE_MOCK_RATES ? "&mock=1" : "");

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("rates http " + res.status);
        return res.json();
      })
      .then(function (data) {
        var days = data.days || {};
        var lowest = null;
        Object.keys(days).forEach(function (iso) {
          var info = days[iso];
          if (info && info.available && info.rate != null && (lowest === null || info.rate < lowest)) {
            lowest = info.rate;
          }
        });
        if (lowest !== null) amountEl.textContent = formatRate(lowest);
      })
      .catch(function () {
        // Degrade silently and leave the static placeholder in place.
      });
  }

  // Sets up a hidden instance of Cloudbeds' own <cb-book-now-button> and
  // loads their loader script, so openCloudbedsOverlay() below has a real
  // Cloudbeds button to click. Standard custom-element upgrade rules mean
  // it doesn't matter that the element exists before Cloudbeds' script has
  // loaded/defined it. Visually hidden, never meant to be seen or clicked
  // by a guest directly — our own "Search" button is.
  //
  // Known limitation, not fixable from this side: Cloudbeds' overlay
  // persists its last-searched room in its own sessionStorage, separately
  // from the URL, and only re-derives it on a genuinely fresh page load —
  // an already-mounted instance keeps showing the OLD room if a guest
  // searches again with the same dates/guests but a different (or
  // cleared) room. Changing checkin/checkout/guests always forces a
  // correct refresh, so this only bites that one narrow case. Extensively
  // tested live: every in-page workaround (pushState alone, an explicit
  // empty value, rewriting their sessionStorage, destroying/recreating
  // this trigger element with or without clearing their storage first)
  // either did nothing or was unreliable — the element-recreation
  // approach sometimes worked and sometimes re-triggered a duplicate
  // script bootstrap (same "import map integrity rule removed" console
  // signature as the old leftover-embed bug) that broke the click
  // entirely. Only a full page reload reliably resets it, which isn't
  // worth the jarring UX for a case expected to come up rarely in
  // practice. Revisit only if Cloudbeds changes how their widget persists
  // search state.
  function initCloudbedsOverlay() {
    var cb = document.createElement("cb-book-now-button");
    cb.setAttribute("property-code", CLOUDBEDS_PROPERTY_CODE);
    cb.setAttribute("label", "Book Now");
    cb.setAttribute("close-label", "Close");
    cb.setAttribute("width", "520px");
    cb.setAttribute("height", "100vh");
    cb.className = "bw-cb-overlay-trigger";

    var innerBtn = document.createElement("button");
    innerBtn.type = "button";
    cb.appendChild(innerBtn);
    document.body.appendChild(cb);
    // Not cached here — Cloudbeds' script replaces/recreates this inner
    // <button> once it upgrades the custom element (confirmed: a
    // reference captured at creation time goes stale/detached), so
    // openCloudbedsOverlay() below re-queries it fresh at click time
    // instead of trusting a stored reference.

    var loader = document.createElement("script");
    loader.src = CLOUDBEDS_LOADER_SRC;
    loader.setAttribute("data-entry", "immersive");
    loader.crossOrigin = "anonymous";
    document.head.appendChild(loader);
  }

  // Writes the picked dates/guests/room onto this page's own URL (no
  // reload — confirmed Cloudbeds' overlay re-reads the URL at the moment
  // it opens) and clicks Cloudbeds' own hidden button, so their overlay
  // opens already search-filled.
  //
  // onOpened, if given, fires once Cloudbeds' overlay has actually mounted
  // in the DOM (or once we've given up waiting) — not merely once we've
  // clicked their button. The caller uses this to know the exact moment
  // it's safe to remove our own panel without a visible gap between the
  // two.
  function openCloudbedsOverlay(onOpened) {
    if (!state.checkin || !state.checkout) return;

    var params = new URLSearchParams();
    params.set("checkin", toISO(state.checkin));
    params.set("checkout", toISO(state.checkout));
    params.set("guests", String(state.adults));
    if (state.roomId) params.set("accommodation_types", state.roomId);

    var url = new URL(location.href);
    url.search = params.toString();
    history.pushState({}, "", url);

    var fellBack = false;
    var fallback = function () {
      if (fellBack) return;
      fellBack = true;
      setSubmitLoading(false);
      // Cloudbeds' script never loaded/upgraded in time (blocked, offline,
      // or still stuck after the generous timeout below) — fall back to
      // their plain hosted reservation page in a new tab rather than
      // leaving the guest stuck on a Search click that does nothing.
      window.open(
        "https://us2.cloudbeds.com/en/reservation/" + CLOUDBEDS_PROPERTY_CODE + "/?" + params.toString(),
        "_blank"
      );
      if (onOpened) onOpened();
    };

    if (typeof customElements === "undefined") {
      fallback();
      return;
    }

    // Lets the guest know we're waiting on Cloudbeds' overlay rather than
    // looking unresponsive — most relevant on a cold cache (first visit
    // this browser session, e.g. incognito) where fetching/parsing their
    // loader bundle can take a few seconds.
    setSubmitLoading(true);

    // Always re-queried, never cached: Cloudbeds' script replaces/recreates
    // the inner <button> once it upgrades the custom element, so a
    // reference captured back at page-init time goes stale and clicking it
    // silently does nothing.
    var btnRetryDeadline = null;
    var clickIt = function () {
      var btn = document.querySelector(".bw-cb-overlay-trigger button");
      if (!btn) {
        // The custom element can register a beat before Cloudbeds attaches
        // its inner <button> — give that a couple more seconds on its own
        // short clock before giving up, rather than falling back instantly.
        if (btnRetryDeadline === null) btnRetryDeadline = Date.now() + 2000;
        if (Date.now() < btnRetryDeadline) {
          requestAnimationFrame(clickIt);
        } else {
          fallback();
        }
        return;
      }

      // Keep our own panel's "still working" feedback up for this whole
      // handoff — Search button text plus the calendar spinner — rather
      // than reverting the button to normal right before Cloudbeds
      // silently resolves whatever it mounts underneath (see the
      // landing-panel skip below, the reason this now takes a bit longer
      // than just the mount itself).
      setHandoffLoading(true);

      // Watch for Cloudbeds' own popup to actually land in the DOM —
      // ".cb-bookingengine-root" is the stable class their overlay mounts
      // under (confirmed by inspecting their shipped bundle), unlike their
      // CSS-module class names, which are hashed and could change on any
      // of their deploys.
      //
      // Cloudbeds' own "landing search panel" (its own date/guest picker +
      // Search button, data-testid="landing-search-panel-search-button")
      // can mount first instead of the room list — confirmed live
      // (2026-11-16) whenever Cloudbeds' internal quote/session cache has
      // gone stale, most commonly after the guest has been idle ~10+
      // minutes (see the "Cloudbeds stale-room limitation" memory). We
      // always hand off a complete search, so that panel is never
      // actionable here. Rather than reveal it and then visibly replace it
      // a moment later, this keeps OUR panel up (with the spinner above)
      // until settled, clicking Cloudbeds' own Search button on the
      // guest's behalf in the meantime — so our panel only ever gives way
      // directly to the finished room list, never to that intermediate
      // screen.
      //
      // Debounced like the scroll-lock safety net elsewhere in this file:
      // Cloudbeds' React tree does transient DOM churn while mounting, so
      // this waits for the DOM to go quiet for a beat before checking,
      // rather than reacting to the very first matching mutation.
      var mounted = false;
      var settlePending = null;
      var LANDING_SEARCH_SELECTOR = '[data-testid="landing-search-panel-search-button"]';
      // The room card's own "Add"/quick-book button — same test-id pattern
      // cloudbeds-quick-book.js already relies on. Used here as the one
      // positive signal that the room list has actually rendered, since
      // ".cb-bookingengine-root" itself mounts as an empty shell first
      // (confirmed live: checking only "no landing button yet" fired
      // finish() during that empty-shell gap, before the landing panel had
      // even rendered into it — revealing it anyway once our panel closed).
      var ROOM_CARD_SELECTOR = '[data-testid^="rate-plan-guest-quantity-select-"]';
      var finish = function () {
        if (mounted) return;
        mounted = true;
        observer.disconnect();
        setSubmitLoading(false);
        setHandoffLoading(false);
        if (onOpened) onOpened();
      };
      var checkSettled = function () {
        if (mounted) return;
        var root = document.querySelector(".cb-bookingengine-root");
        if (!root) return;
        var landingBtn = root.querySelector(LANDING_SEARCH_SELECTOR);
        if (landingBtn) {
          landingBtn.click();
          return; // that click's own re-render triggers another settle check
        }
        // Only finish once the room list has positively rendered — root
        // existing with neither the landing button nor a room card yet is
        // still mid-render, not evidence we're past the landing panel.
        if (root.querySelector(ROOM_CARD_SELECTOR)) finish();
      };
      var scheduleSettleCheck = function () {
        if (settlePending) clearTimeout(settlePending);
        settlePending = setTimeout(checkSettled, 250);
      };
      var observer = new MutationObserver(scheduleSettleCheck);
      observer.observe(document.body, { childList: true, subtree: true });

      btn.click();

      // A click fired the instant the custom element's DOM exists can
      // land before Cloudbeds' React app has finished wiring up its own
      // click handler — the button's there but nothing's listening yet
      // (confirmed live: needed specifically for the auto-resume path
      // after the hard-refresh branch above, where this runs moments
      // after page load; the normal in-page click, happening well after
      // Cloudbeds' script has had time to settle, has always been
      // reliable on the first try). One harmless re-click after a beat,
      // only if the overlay still hasn't mounted, papers over that race.
      setTimeout(function () {
        if (!mounted) btn.click();
      }, 600);

      // Safety net in case Cloudbeds ever changes a class/testid this
      // depends on and a clean settle never happens — don't leave our
      // panel open (or the guest stuck mid-redirect) forever. Longer than
      // the plain-mount case needs (was 1500ms) to leave room for the
      // extra landing-panel-skip round trip this now also waits through.
      setTimeout(finish, 3000);
    };

    // Clicking before Cloudbeds' loader has finished defining
    // <cb-book-now-button> is also a no-op — the custom element isn't
    // upgraded yet, so nothing's listening.
    if (customElements.get("cb-book-now-button")) {
      clickIt();
    } else {
      // Generous safety-net timeout, not a normal-case budget: a cold
      // cache (first visit this browser session — confirmed via incognito
      // testing) can take several seconds to fetch, parse and register
      // Cloudbeds' loader bundle before the custom element exists at all.
      // A short timeout here was popping a surprise new tab on exactly
      // that case even though the overlay would have loaded fine a moment
      // later. This only fires for a genuinely stalled/blocked load.
      var timeout = setTimeout(fallback, 12000);
      customElements.whenDefined("cb-book-now-button").then(function () {
        clearTimeout(timeout);
        if (!fellBack) clickIt();
      });
    }
  }

  // Cloudbeds defaults every search to 2 guests, so its own "Search results
  // for N guests" banner almost always just restates the default back at
  // the guest — only worth showing once someone has actually bumped the
  // count up (3+, at the few places inside Cloudbeds' own UI that allow
  // it). This is the same fix already set up in Cloudbeds' own JavaScript
  // custom-code area; duplicated here as a safety net in case that custom
  // code doesn't get injected into every context this overlay can render
  // in (it's independent — redundant if Cloudbeds' own copy is already
  // running, harmless either way).
  function initGuestCountTextVisibility() {
    var SELECTOR = '[data-testid="occupancy-search-text-for-guests"]';
    var MIN_GUESTS_TO_SHOW = 3;

    function sync() {
      document.querySelectorAll(SELECTOR).forEach(function (el) {
        var match = /(\d+)/.exec(el.textContent || "");
        var count = match ? parseInt(match[1], 10) : null;
        el.style.display = (count !== null && count >= MIN_GUESTS_TO_SHOW) ? "" : "none";
      });
    }

    sync();
    // Cloudbeds' overlay doesn't exist in the DOM until it mounts, and the
    // guest-count text updates in place (not a full element swap) as the
    // guest selector changes — a one-time check on load isn't enough, so
    // this watches the whole document for both.
    new MutationObserver(sync).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Safety net for a confirmed bug in Cloudbeds' own overlay, not ours:
  // their Immersive modal captures document.body.style.overflow as its
  // "previous value" the moment it mounts, then restores exactly that
  // value when it closes. Our own openPanel() above sets overflow:hidden
  // BEFORE handing off to Cloudbeds, so their modal captures "hidden" as
  // its baseline — and faithfully restores "hidden" (not the true
  // original "") once it unmounts. Confirmed live: both .bw-overlay and
  // .cb-bookingengine-root are fully gone from the DOM at that point, yet
  // document.body.style.overflow is still "hidden", leaving the guest
  // unable to scroll the rest of the site. Not fixable inside Cloudbeds'
  // own bundle, so this watches for the moment both overlays are
  // confirmed closed and forces scroll back open whenever that coincides
  // with a still-locked body.
  //
  // Debounced rather than correcting on the very first matching mutation:
  // Cloudbeds' own React tree does transient DOM churn while mounting
  // (nodes briefly removed and re-added), so a single tick where
  // .cb-bookingengine-root happens to be momentarily absent is not
  // reliable evidence their modal has actually closed. Waiting for the
  // DOM to go quiet for a beat, then re-checking, costs nothing in the
  // real stuck-lock case (it persists indefinitely until corrected) while
  // avoiding a correction that fires mid-mount and fights their own
  // overflow handling.
  function initScrollLockSafetyNet() {
    var pending = null;
    function check() {
      var oursOpen = els.panelWrap.classList.contains("is-open");
      var cloudbedsOpen = !!document.querySelector(".cb-bookingengine-root");
      if (!oursOpen && !cloudbedsOpen) {
        if (document.body.style.overflow === "hidden") document.body.style.overflow = "";
        // Same gap as the scroll lock above, same fix shape: Tidio is only
        // ever restored by OUR panel's own close path (closePanel), which
        // never runs when a guest reaches Cloudbeds directly (the resume
        // indicator below) or closes Cloudbeds' own overlay without ever
        // reopening ours. Once both overlays are confirmed gone, Tidio
        // should always be visible again regardless of which path got here.
        setTidioVisible(true);
      }
    }
    function scheduleCheck() {
      if (pending) clearTimeout(pending);
      pending = setTimeout(function () {
        pending = null;
        check();
      }, 250);
    }
    new MutationObserver(scheduleCheck).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"]
    });
  }

  // Cloudbeds' own overlay sometimes mounts its "landing search panel"
  // (dates + guests + their own Search button) instead of jumping straight
  // to the room list, even though we always hand off a complete
  // checkin/checkout/guests via the URL (openCloudbedsOverlay above returns
  // early if any of those are missing). Confirmed live (2026-11-16) this is
  // driven entirely by Cloudbeds' own internal session/quote cache having
  // gone stale — most commonly after the guest has been idle ~10+ minutes —
  // and is not something fixable from our side short of a full page reload
  // (see the "Cloudbeds stale-room limitation" memory; same family of
  // issue). Since we only ever open the overlay with a complete search
  // already decided, this landing panel is never something the guest should
  // need to act on here, so rather than show it, we watch for its own
  // Search button — a stable data-testid confirmed live, not a guessed
  // class — and click it on the guest's behalf the moment it appears.
  //
  // Debounced like the scroll-lock safety net above, for the same reason:
  // Cloudbeds' React tree does transient DOM churn while mounting, so this
  // waits for the DOM to go quiet for a beat before checking rather than
  // reacting to the very first matching mutation.
  function initLandingSearchAutoAdvance() {
    var LANDING_SEARCH_SELECTOR = '[data-testid="landing-search-panel-search-button"]';
    var pending = null;
    function check() {
      var btn = document.querySelector(LANDING_SEARCH_SELECTOR);
      if (btn) btn.click();
    }
    function scheduleCheck() {
      if (pending) clearTimeout(pending);
      pending = setTimeout(function () {
        pending = null;
        check();
      }, 250);
    }
    new MutationObserver(scheduleCheck).observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Cloudbeds keeps its entire cart (room, rate, price) in the same
  // sessionStorage entry as the quote/policy cache already relied on
  // elsewhere in this file — confirmed live (2026-11-16) by reading its
  // "cart.items" array directly. Scans for that entry rather than
  // hardcoding today's key (a numeric id that isn't guaranteed stable)
  // the same way the other reads of this entry already do.
  function getCloudbedsCartSession() {
    for (var i = 0; i < sessionStorage.length; i++) {
      try {
        var raw = sessionStorage.getItem(sessionStorage.key(i));
        if (!raw || raw.indexOf("_expiration") === -1 || raw.indexOf("\"cart\"") === -1) continue;
        var data = JSON.parse(raw);
        if (!data._expiration || Date.now() > Number(data._expiration)) continue;
        var cart = JSON.parse(data.cart);
        if (cart && cart.items && cart.items.length > 0) return cart;
      } catch (e) { /* not the entry we're looking for */ }
    }
    return null;
  }

  // "Confirm your stay" floating indicator — appears only when a guest has
  // closed out of Cloudbeds' overlay (or ours) while something is still
  // sitting in Cloudbeds' own cart, so they don't have to re-pick dates and
  // re-find the same room to pick up where they left off. Clicking it skips
  // our own date-picker panel entirely and re-fires Cloudbeds' hidden
  // trigger directly — confirmed live that this alone is enough for
  // Cloudbeds to reopen straight into the existing cart, since it's reading
  // the same session data this function just checked. Self-contained
  // inline styles throughout (no shared .bw-* classes, no Webflow CSS
  // dependency) so this can't collide with or depend on anything else this
  // script manages.
  //
  // Design from Figma (node 4635:2306): 20px from the bottom-right screen
  // edge, matching .bw-panel's own edge offset exactly. Expand-icon SVG
  // (node 4637:2325, updated 2026-11-16) is a single flattened 16x16 asset
  // now, downloaded and inlined directly — no nested positioning needed.
  function buildResumeIndicator() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bw-resume-indicator";
    btn.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:999999;" +
      "display:none;align-items:center;gap:10px;padding:8px 12px;" +
      "background:#fff;border:1px solid #465850;border-radius:2px;" +
      "box-shadow:0 2px 10px rgba(0,0,0,0.15);cursor:pointer;" +
      "font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;font-size:14px;" +
      "color:#465850;letter-spacing:0.14px;line-height:1.5;white-space:nowrap;";
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;">' +
        '<path d="M13 2H15.5V15.5H0.5V2H3" stroke-linecap="round" stroke-linejoin="round" stroke="#465850"/>' +
        '<rect x="11" y="0.5" width="2" height="3" stroke-linecap="round" stroke-linejoin="round" stroke="#465850"/>' +
        '<rect x="3" y="0.5" width="2" height="3" stroke-linecap="round" stroke-linejoin="round" stroke="#465850"/>' +
        '<path d="M5 2H11" stroke-linecap="round" stroke-linejoin="round" stroke="#465850"/>' +
        '<path d="M5 9.57143L6.71429 11.2857L11 7" stroke-linecap="round" stroke-linejoin="round" stroke="#465850"/>' +
      '</svg>' +
      '<span class="bw-resume-indicator-text">Confirm your stay</span>' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;">' +
        '<path d="M6.5 6.5L1 1M1 6V1H6" stroke-linejoin="round" stroke="#465850"/>' +
        '<path d="M9.5 9.49955L15 14.9996M15 9.99955V14.9996L10 14.9996" stroke-linejoin="round" stroke="#465850"/>' +
      '</svg>';

    document.body.appendChild(btn);
    return btn;
  }

  function initResumeIndicator() {
    var btn = buildResumeIndicator();
    var textEl = btn.querySelector(".bw-resume-indicator-text");
    var busy = false;

    function sync() {
      if (busy) return;
      var oursOpen = els.panelWrap.classList.contains("is-open");
      var cloudbedsOpen = !!document.querySelector(".cb-bookingengine-root");
      var shouldShow = !oursOpen && !cloudbedsOpen && !!getCloudbedsCartSession();
      btn.style.display = shouldShow ? "flex" : "none";
    }

    btn.addEventListener("click", function () {
      if (busy) return;
      var cbBtn = document.querySelector(".bw-cb-overlay-trigger button");
      if (!cbBtn) return;

      busy = true;
      textEl.textContent = "Opening…";
      btn.disabled = true;
      setTidioVisible(false);

      // Same settle pattern as openCloudbedsOverlay above: don't treat
      // ".cb-bookingengine-root" existing as proof of anything by itself
      // (it mounts as an empty shell first) and don't react to Cloudbeds'
      // own landing panel if its session happened to go stale between the
      // check above and this click — just in case, even though clicking
      // only shows while that check just passed.
      var settled = false;
      var pending = null;
      var LANDING_SEARCH_SELECTOR = '[data-testid="landing-search-panel-search-button"]';
      var ROOM_OR_CART_SELECTOR =
        '[data-testid^="rate-plan-guest-quantity-select-"],[data-testid*="shopping-cart"]';
      var finishOpen = function () {
        if (settled) return;
        settled = true;
        observer.disconnect();
        busy = false;
        btn.disabled = false;
        textEl.textContent = "Confirm your stay";
        btn.style.display = "none";
      };
      var checkSettled = function () {
        if (settled) return;
        var root = document.querySelector(".cb-bookingengine-root");
        if (!root) return;
        var landingBtn = root.querySelector(LANDING_SEARCH_SELECTOR);
        if (landingBtn) {
          landingBtn.click();
          return;
        }
        if (root.querySelector(ROOM_OR_CART_SELECTOR)) finishOpen();
      };
      var observer = new MutationObserver(function () {
        if (pending) clearTimeout(pending);
        pending = setTimeout(checkSettled, 250);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      cbBtn.click();

      // Safety net matching the pattern elsewhere in this file — don't
      // leave the indicator stuck in "Opening…" forever if something
      // about Cloudbeds' DOM ever changes underneath this.
      setTimeout(finishOpen, 3000);
    });

    sync();
    new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
    // Catches pure time-based expiry (the cart's own _expiration passing
    // while the guest is just sitting on a page, no DOM mutation to react
    // to) — cheap enough to run this often.
    setInterval(sync, 15000);
  }

  function init() {
    buildPanel();
    wireTriggers();
    initRateCardPrice();
    initCloudbedsOverlay();
    initGuestCountTextVisibility();
    initScrollLockSafetyNet();
    initLandingSearchAutoAdvance();
    initResumeIndicator();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
