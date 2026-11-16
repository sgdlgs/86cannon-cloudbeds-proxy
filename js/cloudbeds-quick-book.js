/*
 * 86 Cannon — Cloudbeds "quick book" shortcut.
 *
 * Collapses Cloudbeds' own room-list flow (Add -> guest-count popover ->
 * Confirm -> cart updates -> separate Book Now click) into a single click.
 * Runs against Cloudbeds' stock "Immersive Experience" room-list UI, which
 * renders straight into the light DOM on both pages that use it — no shadow
 * root, so plain querySelector reaches it — but the cart's own final
 * confirm button carries a DIFFERENT data-testid depending on which shell
 * it's rendered inside, confirmed by testing both live on 2026-11-04:
 *   - /cloudbeds/cloudbeds-standard (inline <cb-immersive-experience>):
 *     "shopping-cart-confirm-button"
 *   - /cloudbeds-overlay (slide-in panel via <cb-book-now-button>):
 *     "shopping-cart-banner-confirm-button"
 * CART_BOOK_NOW_SELECTOR below matches both (and any future Cloudbeds
 * variant following the same naming). Everything else — the Add button's
 * testid shape and the popover's confirm button — was identical on both
 * pages. Selectors are Cloudbeds' own intentional data-testid hooks, not
 * generated class names, which is what makes touching their markup here
 * reasonably safe.
 *
 * Deliberate trade-off: this makes the Add button a one-click "go straight
 * to checkout" action. A guest who wants to add a *second* room to the same
 * cart before checking out no longer can from the room list — clicking Add
 * on the first room now jumps straight past the cart. That's the ask
 * (single-room quick booking), not an oversight.
 *
 * Everything here degrades silently: if Cloudbeds ever changes this markup
 * and a selector stops matching, the guest just lands back in the normal
 * manual flow (popover open, or room sitting in the cart) instead of
 * anything breaking.
 *
 * While the quick-book sequence is running, <html> gets a "cb-quickbook"
 * class so companion CSS (in this project's custom code, not this file) can
 * hide the guest-count popover's visible flash-open/flash-closed instead of
 * letting the guest see Cloudbeds' own popover blink past. The class is
 * always removed in a .finally(), success or failure, so a timeout never
 * leaves the popover permanently hidden.
 */
(function () {
  "use strict";

  // Matches ONLY the room's own Add button, e.g.
  // "rate-plan-guest-quantity-select-275890651795649-280572341178560".
  // The popover's internal steppers/inputs share the same prefix with an
  // extra suffix (-quantity-minus-button, -adults-input, etc.) — the
  // trailing \d+-\d+ anchor is what excludes those.
  var ADD_BUTTON_TESTID = /^rate-plan-guest-quantity-select-\d+-\d+$/;
  var CONFIRM_BUTTON_SELECTOR = '[data-testid="guestselector-popover-confirm-button"]';
  // Contains "shopping-cart" AND ends in "confirm-button" rather than an
  // exact match, so it covers both known testids (see header comment)
  // without also matching the unrelated guestselector popover's confirm
  // button or Cloudbeds' own hidden <cb-book-now-button> trigger (neither
  // has "shopping-cart" in its testid/has no testid at all).
  var CART_BOOK_NOW_SELECTOR = '[data-testid*="shopping-cart"][data-testid$="confirm-button"]';
  var BOUND_FLAG = "bwQuickBook";
  var QUICKBOOK_CLASS = "cb-quickbook";

  function findAddButtons() {
    var candidates = document.querySelectorAll('button[data-testid^="rate-plan-guest-quantity-select-"]');
    var result = [];
    for (var i = 0; i < candidates.length; i++) {
      var testId = candidates[i].getAttribute("data-testid") || "";
      if (ADD_BUTTON_TESTID.test(testId)) result.push(candidates[i]);
    }
    return result;
  }

  function relabel(btn) {
    var label = btn.querySelector(".cb-text");
    if (label && label.textContent.trim() === "Add") {
      label.textContent = "Book Now";
    }
  }

  // Lightweight poll instead of a MutationObserver for this part — the
  // popover and the cart button each show up within a render tick or two,
  // so a short interval poll with a generous timeout is simpler and matches
  // the retry style already used elsewhere in this project.
  function waitFor(getEl, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      (function tick() {
        var el = getEl();
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
        setTimeout(tick, 50);
      })();
    });
  }

  function handleQuickBookClick() {
    document.documentElement.classList.add(QUICKBOOK_CLASS);
    waitFor(function () {
      var el = document.querySelector(CONFIRM_BUTTON_SELECTOR);
      return el && !el.disabled ? el : null;
    }, 4000)
      .then(function (confirmBtn) {
        confirmBtn.click();
        return waitFor(function () {
          var el = document.querySelector(CART_BOOK_NOW_SELECTOR);
          return el && !el.disabled ? el : null;
        }, 4000);
      })
      .then(function (bookNowBtn) {
        bookNowBtn.click();
      })
      .catch(function () {
        // Confirm or Book Now never showed up/enabled in time (Cloudbeds
        // changed something, or a validation state blocked it) — leave the
        // guest exactly where Cloudbeds' own UI put them and do nothing
        // further. No error surfaced; this is a convenience shortcut, not
        // the booking flow itself.
      })
      .finally(function () {
        // Always runs, success or timeout, so a failed run never leaves the
        // popover permanently hidden behind the companion CSS.
        document.documentElement.classList.remove(QUICKBOOK_CLASS);
      });
  }

  function scan() {
    var buttons = findAddButtons();
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.disabled) continue; // sold out / already in cart — leave alone
      relabel(btn);
      if (!btn.dataset[BOUND_FLAG]) {
        btn.dataset[BOUND_FLAG] = "1";
        // Added alongside Cloudbeds' own click handling, not instead of it —
        // this never calls preventDefault/stopPropagation, so their popover
        // still opens normally; we just immediately drive it forward.
        btn.addEventListener("click", handleQuickBookClick);
      }
    }
  }

  function init() {
    scan();
    var observer = new MutationObserver(function () {
      scan();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"]
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
