(function () {
  const DEFAULT_URL = "https://gmail-tracker-dashboard.vercel.app";
  const state = {
    dashboardUrl: DEFAULT_URL,
    trackingEnabled: true,
    tracks: [],
    lastOpenCount: new Map(),
    senderViewsMarked: new Map(),
    isRefreshing: false,
    currentAccountEmail: ""
  };
  const trackingPromises = new WeakMap();
  const TRACKING_IMAGE_SELECTOR = [
    "img[data-gt-pixel]",
    "img[data-gt-marker]",
    "img[data-gt-src]",
    "img[alt^='Tracking pixel']",
    ".gt-dev-pixel img"
  ].join(", ");

  chrome.storage.sync.get(["dashboardUrl", "trackingEnabled"], (values) => {
    state.dashboardUrl = (values.dashboardUrl || DEFAULT_URL).replace(/\/$/, "");
    state.trackingEnabled = values.trackingEnabled !== false;
    renderPanel();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.dashboardUrl) state.dashboardUrl = changes.dashboardUrl.newValue.replace(/\/$/, "");
    if (changes.trackingEnabled) state.trackingEnabled = changes.trackingEnabled.newValue !== false;
    renderPanel();
  });

  setInterval(() => {
    enhanceComposeWindows();
    cleanupMisplacedTrackingLabels();
    decorateEmailRows();
    decorateOpenEmailViews();
    markSenderSideViews();
  }, 1200);

  setInterval(renderPanel, 400);

  function getAccountEmail() {
    const accountNode = document.querySelector("a[aria-label*='Google Account']")
      || document.querySelector("a[href*='SignOutOptions']")
      || document.querySelector("[aria-label*='Google Account']");
    const label = accountNode?.getAttribute("aria-label") || accountNode?.textContent || "";
    const match = label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match?.[0]) {
      state.currentAccountEmail = match[0].toLowerCase();
    }
    return state.currentAccountEmail;
  }

  function isTrackForCurrentSender(track) {
    const accountEmail = normalizeEmail(getAccountEmail());
    return !!accountEmail && normalizeEmail(track?.senderEmail) === accountEmail;
  }

  function filterTracksForCurrentSender(tracks) {
    return Array.isArray(tracks) ? tracks.filter(isTrackForCurrentSender) : [];
  }

  function getComposeWindows() {
    return Array.from(document.querySelectorAll("div[role='dialog']")).filter((dialog) =>
      getMessageBody(dialog)
    );
  }

  function getMessageBody(compose) {
    return compose.querySelector("div[aria-label='Message Body']")
      || compose.querySelector("div[contenteditable='true'][role='textbox']")
      || compose.querySelector(".Am.Al.editable[contenteditable='true']")
      || compose.querySelector("div[contenteditable='true'][g_editable='true']")
      || compose.querySelector("div[contenteditable='true']");
  }

  function enhanceComposeWindows() {
    for (const compose of getComposeWindows()) {
      if (compose.dataset.gtEnhanced !== "true") {
        compose.dataset.gtEnhanced = "true";

        compose.addEventListener("click", async (event) => {
          const target = event.target instanceof Element ? event.target : null;
          const sendButton = target?.closest("div[role='button']");
          const label = sendButton?.getAttribute("aria-label") || sendButton?.getAttribute("data-tooltip") || "";
          if (!sendButton || !/send/i.test(label) || sendButton.dataset.gtPending === "true") return;
          if (!state.trackingEnabled) return;
          if (sendButton.dataset.gtSendAfterTracking === "true") {
            delete sendButton.dataset.gtSendAfterTracking;
            return;
          }

          event.preventDefault();
          event.stopImmediatePropagation();
          sendButton.dataset.gtPending = "true";
          try {
            await insertTrackingPixels(compose, { force: true });
            if (!hasSendableTrackingPixel(getMessageBody(compose))) {
              throw new Error("Gmail Tracker could not add the tracking pixel before send.");
            }
            await updateTrackingMetadata(compose);
            activateTrackingPixels(compose);
            sendButton.dataset.gtSendAfterTracking = "true";
            sendButton.click();
          } catch (error) {
            console.error("Gmail Tracker failed to insert tracking pixel", error);
          } finally {
            setTimeout(() => {
              delete sendButton.dataset.gtPending;
            }, 2000);
          }
        }, true);
      }

      installComposeControl(compose);
      if (state.trackingEnabled && compose.dataset.gtTracked !== "true" && compose.dataset.gtTrackingPending !== "true") {
        insertTrackingPixels(compose)
          .catch((error) => {
            console.error("Gmail Tracker failed to auto-insert tracking pixel", error);
          });
      }
    }
  }

  function installComposeControl(compose) {
    if (compose.querySelector(".gt-compose-control")) return;

    const sendButton = getSendButton(compose);
    if (!sendButton) return;

    const control = document.createElement("span");
    control.className = "gt-compose-control";
    control.innerHTML = `
      <button class="gt-compose-icon" type="button" title="${state.trackingEnabled ? "Tracking on" : "Tracking off"}" aria-label="${state.trackingEnabled ? "Tracking on" : "Tracking off"}">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>
      <span>${state.trackingEnabled ? "Tracking on" : "Tracking off"}</span>
    `;
    const sendContainer = sendButton.closest("td") || sendButton.parentElement || sendButton;
    if (sendContainer.tagName === "TD") {
      const cell = document.createElement("td");
      cell.className = "gt-compose-control-cell";
      cell.appendChild(control);
      sendContainer.insertAdjacentElement("afterend", cell);
    } else {
      sendContainer.insertAdjacentElement("afterend", control);
    }
  }

  function getSendButton(compose) {
    return Array.from(compose.querySelectorAll("div[role='button']")).find((button) => {
      const label = button.getAttribute("aria-label") || button.getAttribute("data-tooltip") || "";
      return /^send\b/i.test(label) || /\bsend\b/i.test(label);
    });
  }

  async function insertTrackingPixels(compose, options = {}) {
    const body = getMessageBody(compose);
    if (!body) return;

    if (compose.dataset.gtTracked === "true" && hasSendableTrackingPixel(body)) return;
    if (compose.dataset.gtTracked === "true") delete compose.dataset.gtTracked;
    if (options.force && !hasSendableTrackingPixel(body)) delete compose.dataset.gtTrackingPending;
    if (trackingPromises.has(compose)) return trackingPromises.get(compose);

    const promise = createTrackingPixels(compose, body, options);
    trackingPromises.set(compose, promise);
    try {
      await promise;
    } finally {
      trackingPromises.delete(compose);
    }
  }

  async function createTrackingPixels(compose, body, options = {}) {
    compose.dataset.gtTrackingPending = "true";

    const senderEmail = getAccountEmail();
    if (!senderEmail) {
      delete compose.dataset.gtTrackingPending;
      throw new Error("Gmail Tracker could not detect the current Gmail account.");
    }

    const subject = compose.querySelector("input[name='subjectbox']")?.value || "";
    const recipients = getRecipients(compose);
    const targets = [recipients[0] || "unknown-recipient"];
    const now = new Date().toISOString();
    const markers = options.force && !getTrackingImages(body).length ? [] : ensureTrackingMarkers(body, targets);

    try {
      for (const recipientEmail of targets) {
        const gmailMessageKey = `${senderEmail}:${recipientEmail}:${Date.now()}:${crypto.randomUUID()}`;
        const response = await fetch(`${state.dashboardUrl}/api/tracks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ senderEmail, recipientEmail, subject, gmailMessageKey, sentAt: now, sent: false })
        });

        if (!response.ok) throw new Error(`Tracker backend returned ${response.status}`);
        const data = await response.json();
        let marker = markers.find((item) => item.recipientEmail === recipientEmail);
        if (!marker && options.force) {
          marker = appendTrackingMarker(body, recipientEmail, data.pixelUrl, data.track.id);
        }
        const image = marker?.image || (marker?.markerId ? body.querySelector(`img[data-gt-marker="${marker.markerId}"]`) : null);
        if (image) {
          normalizeTrackingWrapper(image);
          if (options.force) image.setAttribute("src", data.pixelUrl);
          else image.setAttribute("data-gt-src", data.pixelUrl);
          image.setAttribute("data-gt-pixel", data.track.id);
          image.removeAttribute("data-gt-marker");
          image.removeAttribute("data-surl");
          image.removeAttribute("data-image-whitelisted");
          image.removeAttribute("data-bit");
        }
        if (isTrackForCurrentSender(data.track)) {
          state.tracks = [data.track, ...state.tracks.filter((track) => track.id !== data.track.id)];
        }
      }

      compose.dataset.gtTracked = "true";
    } catch (error) {
      delete compose.dataset.gtTracked;
      throw error;
    } finally {
      delete compose.dataset.gtTrackingPending;
    }
  }

  async function updateTrackingMetadata(compose) {
    const senderEmail = getAccountEmail();
    if (!senderEmail) return;
    const body = getMessageBody(compose);
    if (!body) return;

    const subject = compose.querySelector("input[name='subjectbox']")?.value || "";
    const content = getEmailContent(compose);
    const recipients = getRecipients(compose);
    const recipientEmail = recipients[0] || "unknown-recipient";
    const images = getTrackingImages(body).filter((image) => image.hasAttribute("data-gt-pixel"));

    await Promise.all(images.map((image) => fetch(`${state.dashboardUrl}/api/tracks/${image.getAttribute("data-gt-pixel")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderEmail, recipientEmail, subject, bodyHtml: content.html, bodyText: content.text, sentAt: new Date().toISOString(), sent: true })
    })));
  }

  function getEmailContent(compose) {
    const body = getMessageBody(compose);
    if (!body) return { html: "", text: "" };

    const clone = body.cloneNode(true);
    for (const node of clone.querySelectorAll(".gt-dev-pixel")) node.remove();
    for (const node of clone.querySelectorAll(TRACKING_IMAGE_SELECTOR)) node.remove();

    return {
      html: clone.innerHTML.trim(),
      text: (clone.textContent || "").trim()
    };
  }

  function ensureTrackingMarkers(body, targets) {
    const existingImages = getTrackingImages(body);
    if (existingImages.length) {
      return existingImages.map((image, index) => ({
        markerId: image.getAttribute("data-gt-marker"),
        recipientEmail: targets[index] || targets[0],
        image
      }));
    }

    return targets.map((recipientEmail) => appendTrackingMarker(body, recipientEmail));
  }

  function appendTrackingMarker(body, recipientEmail, pixelUrl = "", trackId = "") {
    const markerId = trackId ? "" : `gt-${crypto.randomUUID()}`;
    body.insertAdjacentHTML("beforeend", createTrackingMarker(pixelUrl, trackId, recipientEmail, markerId));
    const image = trackId
      ? body.querySelector(`img[data-gt-pixel="${trackId}"]`)
      : body.querySelector(`img[data-gt-marker="${markerId}"]`);
    if (image) normalizeTrackingWrapper(image);
    return { markerId, recipientEmail, image };
  }

  function normalizeTrackingWrapper(image) {
    const wrapper = image.closest("span") || image.parentElement;
    if (!wrapper) return;

    wrapper.classList.add("gt-dev-pixel");
    wrapper.setAttribute("contenteditable", "false");
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.style.display = "none";
    wrapper.style.width = "20px";
    wrapper.style.height = "20px";
    wrapper.style.maxWidth = "20px";
    wrapper.style.maxHeight = "20px";
    wrapper.style.overflow = "hidden";
    wrapper.style.lineHeight = "0";
    wrapper.style.fontSize = "0";
  }

  function createTrackingMarker(pixelUrl, trackId, recipientEmail, markerId) {
    const pendingSrc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAALSURBVBhXY2BABwAAEgABp3qZbgAAAABJRU5ErkJggg==";
    const src = pixelUrl || pendingSrc;
    return `
      <span class="gt-dev-pixel" contenteditable="false" aria-hidden="true" style="display:none;width:20px;height:20px;max-width:20px;max-height:20px;overflow:hidden;line-height:0;font-size:0;">
        <img
          ${markerId ? `data-gt-marker="${escapeHtml(markerId)}"` : ""}
          src="${escapeHtml(src)}"
          ${pixelUrl ? `data-gt-src="${escapeHtml(pixelUrl)}"` : ""}
          width="20"
          height="20"
          style="display:block;width:20px;height:20px;max-width:20px;max-height:20px;border:0;outline:0;"
          alt="Tracking pixel for ${escapeHtml(recipientEmail)}"
          ${trackId ? `data-gt-pixel="${escapeHtml(trackId)}"` : ""}
        >
      </span>
    `;
  }

  function activateTrackingPixels(compose) {
    const body = getMessageBody(compose);
    if (!body) return;

    for (const image of getTrackingImages(body).filter((item) => item.hasAttribute("data-gt-src"))) {
      image.setAttribute("src", image.getAttribute("data-gt-src"));
      image.removeAttribute("data-gt-src");
    }
    setTimeout(markSenderSideViews, 1500);
    setTimeout(markSenderSideViews, 5000);
  }

  function getTrackingImages(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll(TRACKING_IMAGE_SELECTOR));
  }

  function hasSendableTrackingPixel(root) {
    return getTrackingImages(root).some((image) => (
      image.hasAttribute("data-gt-pixel")
      && (image.hasAttribute("data-gt-src") || (image.getAttribute("src") || "").includes("/api/pixel/"))
    ));
  }

  function getRecipients(compose) {
    const found = new Set();
    const candidates = compose.querySelectorAll("[email], [data-hovercard-id], span[email], input[name='to'], textarea[name='to']");
    for (const node of candidates) {
      const value = node.getAttribute("email") || node.getAttribute("data-hovercard-id") || node.value || node.textContent || "";
      for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
        found.add(match[0].toLowerCase());
      }
    }
    return Array.from(found);
  }

  async function refreshTracks() {
      try {
        const senderEmail = getAccountEmail();
        if (!senderEmail) {
          state.tracks = [];
          renderPanel();
          decorateEmailRows();
          decorateOpenEmailViews();
          return;
        }

        const response = await fetch(`${state.dashboardUrl}/api/tracks?senderEmail=${encodeURIComponent(senderEmail)}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        state.tracks = filterTracksForCurrentSender(data.tracks || []);
        notifyNewOpens(state.tracks);
        renderPanel();
        decorateEmailRows();
        decorateOpenEmailViews();
    } catch {
      // Dashboard may be offline while Gmail is open.
    }
  }

  async function markSenderSideViews() {
    const senderEmail = getAccountEmail();
    if (!senderEmail) return;

    const trackIds = findTrackingIdsInPage();
    if (!trackIds.length) return;

    const now = Date.now();
    const ownedTrackIds = new Set(state.tracks.filter(isTrackForCurrentSender).map((track) => track.id));
    for (const trackId of trackIds) {
      if (!ownedTrackIds.has(trackId)) continue;
      const lastMarkedAt = state.senderViewsMarked.get(trackId) || 0;
      if (now - lastMarkedAt < 8000) continue;
      state.senderViewsMarked.set(trackId, now);

      try {
        await fetch(`${state.dashboardUrl}/api/tracks/${trackId}/sender-view`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ senderEmail, source: "gmail_sender_view", detectedAt: new Date(now).toISOString() })
        });
      } catch (error) {
        state.senderViewsMarked.delete(trackId);
      }
    }
  }

  function findTrackingIdsInPage() {
    const ids = new Set();
    const nodes = document.querySelectorAll("img[src], a[href]");

    for (const node of nodes) {
      const raw = node.getAttribute("src") || node.getAttribute("href") || "";
      const values = [raw, decodeURIComponent(raw)];
      const hashIndex = raw.indexOf("#");
      if (hashIndex >= 0) values.push(raw.slice(hashIndex + 1), decodeURIComponent(raw.slice(hashIndex + 1)));

      for (const value of values) {
        const match = value.match(/\/api\/pixel\/([a-f0-9-]{36})\.(?:png|gif|jpe?g|webp)/i);
        if (match) ids.add(match[1]);
      }
    }

    return Array.from(ids);
  }

  function notifyNewOpens(tracks) {
    for (const track of tracks) {
      const previous = state.lastOpenCount.get(track.id) ?? track.openCount;
      if (track.openCount > previous) {
        chrome.runtime.sendMessage({ type: "TRACK_OPENED_NOTIFICATION", subject: track.subject });
      }
      state.lastOpenCount.set(track.id, track.openCount);
    }
  }

  function renderPanel() {
    let launcher = document.querySelector(".gt-launcher");
    if (!launcher) {
      launcher = document.createElement("button");
      launcher.className = "gt-launcher";
      launcher.type = "button";
      launcher.title = "Gmail Tracker";
      launcher.innerHTML = trackerLogo();
      launcher.addEventListener("click", toggleSummaryModal);
    }

    const host = getPanelHost();
    if (host && launcher.parentElement !== host) {
      host.appendChild(launcher);
    } else if (!host && !launcher.parentElement) {
      document.body.prepend(launcher);
    }

    positionLauncherNearSearch(launcher);
  }

  function trackerLogo() {
    return `
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <defs>
          <linearGradient id="gtLogoGradient" x1="8" x2="40" y1="6" y2="42">
            <stop offset="0" stop-color="#34d399"></stop>
            <stop offset="1" stop-color="#065f46"></stop>
          </linearGradient>
        </defs>
        <rect x="5" y="5" width="38" height="38" rx="10" fill="url(#gtLogoGradient)"></rect>
        <path d="M12 16h24v17H12z" fill="none" stroke="#ecfdf5" stroke-width="2.4"></path>
        <path d="m12 17 12 9 12-9" fill="none" stroke="#ecfdf5" stroke-width="2.4"></path>
        <text x="24" y="34" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="800" fill="#ecfdf5">GT</text>
      </svg>
    `;
  }

  function toggleSummaryModal() {
    const modal = renderSummaryModal(true);
    modal.classList.toggle("gt-modal-open");
  }

  function renderSummaryModal(forceCreate) {
    let modal = document.querySelector(".gt-summary-modal");
    if (!modal && !forceCreate) return null;
    if (!modal) {
      modal = document.createElement("aside");
      modal.className = "gt-summary-modal";
      document.body.appendChild(modal);
    }

    const total = state.tracks.length;
    const viewed = state.tracks.filter((track) => track.openCount > 0).length;
    const accountEmail = getAccountEmail();
    const rows = state.tracks.slice(0, 8).map((track) => `
      <div class="gt-panel-row">
        <strong>${escapeHtml(track.subject || "(No subject)")}</strong>
        <span>${escapeHtml(track.recipientEmail)} - ${track.openCount > 0 ? `Viewed ${track.openCount}x, ${formatRelativeTime(track.lastOpenedAt)}` : "No view"}</span>
      </div>
    `).join("");

    modal.innerHTML = `
      <header>
        <span class="gt-modal-title">${trackerLogo()} Gmail Tracker</span>
        <div class="gt-modal-actions">
          <button type="button" class="gt-modal-refresh" aria-label="Refresh" ${state.isRefreshing ? "disabled" : ""}>
            <span class="gt-refresh-spinner" aria-hidden="true"></span>
            <span>${state.isRefreshing ? "Refreshing" : "Refresh"}</span>
          </button>
          <button type="button" class="gt-modal-close" aria-label="Close">x</button>
        </div>
      </header>
      <div class="gt-modal-account">Showing sent emails for ${accountEmail ? escapeHtml(accountEmail) : "this Gmail account"}</div>
      <div class="gt-modal-metrics">
        <div><strong>${total}</strong><span>tracked</span></div>
        <div><strong>${viewed}</strong><span>viewed</span></div>
        <div><strong>${total - viewed}</strong><span>no view</span></div>
      </div>
      <header class="gt-modal-subhead">
        <span>Recent emails</span>
        <a href="${escapeHtml(state.dashboardUrl)}" target="_blank" rel="noreferrer">Dashboard</a>
      </header>
      ${rows || '<div class="gt-panel-row"><span>No tracked emails yet</span></div>'}
    `;
    modal.querySelector(".gt-modal-close")?.addEventListener("click", () => modal.classList.remove("gt-modal-open"));
    modal.querySelector(".gt-modal-refresh")?.addEventListener("click", refreshTrackingUi);
    positionModalNearLauncher(modal);
    return modal;
  }

  async function refreshTrackingUi() {
    if (state.isRefreshing) return;
    state.isRefreshing = true;
    renderSummaryModal(false);
    try {
      await refreshTracks();
      cleanupMisplacedTrackingLabels();
      decorateEmailRows();
      decorateOpenEmailViews();
    } finally {
      state.isRefreshing = false;
      renderSummaryModal(false);
    }
  }

  function getPanelHost() {
    let host = document.querySelector(".gt-panel-host");
    if (host) return host;

    const search = document.querySelector("form[role='search']");
    if (!search) return null;

    host = document.createElement("div");
    host.className = "gt-panel-host";
    search.insertAdjacentElement("afterend", host);
    return host;
  }

  function positionLauncherNearSearch(launcher) {
    const search = document.querySelector("form[role='search']");
    if (!search) {
      launcher.classList.add("gt-launcher-hidden");
      return;
    }

    const rect = search.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 28 || rect.top < 0 || rect.left < 0) {
      launcher.classList.add("gt-launcher-hidden");
      return;
    }

    const left = Math.min(rect.right + 12, window.innerWidth - 52);
    launcher.style.top = `${Math.max(8, rect.top + 4)}px`;
    launcher.style.left = `${Math.max(12, left)}px`;
    launcher.classList.remove("gt-launcher-hidden");

    const modal = document.querySelector(".gt-summary-modal.gt-modal-open");
    if (modal) positionModalNearLauncher(modal);
  }

  function positionModalNearLauncher(modal) {
    const launcher = document.querySelector(".gt-launcher");
    if (!launcher) return;

    const rect = launcher.getBoundingClientRect();
    modal.style.top = `${rect.bottom + 8}px`;
    modal.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
  }

  function decorateEmailRows() {
    cleanupMisplacedTrackingLabels();
    if (!state.tracks.length) {
      document.querySelectorAll(".gt-status-badge").forEach((badge) => badge.remove());
      return;
    }

    const rows = getEmailListRows();
    const usedTrackIds = new Set();
    for (const row of rows) {
      const timeWrap = row.querySelector("td.xW span[title]");
      if (!timeWrap) {
        row.querySelector(".gt-status-badge")?.remove();
        continue;
      }

      const track = findBestTrackForRow(row, usedTrackIds);
      if (!track) {
        row.querySelector(".gt-status-badge")?.remove();
        continue;
      }
      usedTrackIds.add(track.id);

      let badge = row.querySelector(".gt-status-badge");
      if (!badge) {
        badge = document.createElement("span");
      }
      if (badge.parentElement !== timeWrap) {
        timeWrap.insertAdjacentElement("afterbegin", badge);
      }
      badge.className = `gt-status-badge ${track.openCount > 0 ? "gt-status-opened" : "gt-status-unread"}`;
      badge.innerHTML = statusBadgeMarkup(track, true);
      badge.title = track.openCount > 0
        ? `${track.openCount} receiver view${track.openCount === 1 ? "" : "s"} - last ${formatRelativeTime(track.lastOpenedAt)}`
        : "No recipient opens yet";
      badge.setAttribute("aria-label", badge.title);
    }

    cleanupMisplacedTrackingLabels();
  }

  function getEmailListRows() {
    return Array.from(document.querySelectorAll("div[role='main'] tr.zA[role='row']")).filter(isEmailListRow);
  }

  function isEmailListRow(row) {
    if (!(row instanceof Element)) return false;
    if (row.closest("div[role='dialog'], form[role='search'], nav, [role='navigation'], .gt-summary-modal")) return false;
    if (!row.querySelector("td.xW span[title]")) return false;
    if (!row.querySelector("td.xY, td.a4W")) return false;
    if (!row.querySelector(".bog")) return false;
    if (!row.querySelector(".y2")) return false;

    const rect = row.getBoundingClientRect();
    return rect.width > 240 && rect.height > 12;
  }

  function findBestTrackForRow(row, usedTrackIds) {
    const rowText = normalizeText(row.textContent || "");
    const rowSubject = normalizeText(row.querySelector(".bog")?.textContent || "");
    const rowSnippet = normalizeText(row.querySelector(".y2")?.textContent || "");
    const rowTime = getRowTimestamp(row);

    let best = null;
    let bestScore = -1;

    for (const track of state.tracks) {
      if (usedTrackIds.has(track.id)) continue;
      if (!matchesRequiredEmailIdentity(track, rowSubject, rowText)) continue;

      const body = normalizeText(track.bodyText || "");
      let score = 0;

      const bodySample = body.slice(0, 120);
      if (bodySample && rowSnippet && (bodySample.includes(rowSnippet) || rowSnippet.includes(bodySample.slice(0, 40)))) {
        score += 35;
      }

      if (rowTime) {
        const minutes = Math.abs(rowTime.getTime() - new Date(track.sentAt || track.createdAt).getTime()) / 60000;
        if (minutes <= 2) score += 20;
        else if (minutes <= 20) score += 10;
        else if (minutes <= 1440) score += 4;
      }

      if (score > bestScore) {
        bestScore = score;
        best = track;
      }
    }

    return best;
  }

  function matchesRequiredEmailIdentity(track, subjectText, containerText) {
    const subject = normalizeText(track.subject);
    return isTrackForCurrentSender(track)
      && !!subject
      && subjectText === subject
      && textIncludesEmailIdentity(containerText, track.recipientEmail);
  }

  function textIncludesEmailIdentity(text, email) {
    const normalizedText = normalizeText(text);
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return false;

    const localPart = normalizeText(normalizedEmail.split("@")[0] || "");
    return normalizedText.includes(normalizedEmail) || (!!localPart && normalizedText.includes(localPart));
  }

  function getRowTimestamp(row) {
    const title = row.querySelector("td.xW span[title]")?.getAttribute("title") || "";
    const parsed = Date.parse(title);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  function normalizeText(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function normalizeEmail(value) {
    return String(value || "").toLowerCase().trim();
  }

  function decorateOpenEmailViews() {
    cleanupMisplacedTrackingLabels();
    if (!state.tracks.length) {
      document.querySelectorAll(".gt-thread-status").forEach((status) => status.remove());
      return;
    }

    const subjectNodes = document.querySelectorAll("div[role='main'] h2.hP, div[role='main'] h2[data-thread-perm-id]");
    for (const subjectNode of subjectNodes) {
      if (!isConversationSubject(subjectNode)) continue;

      const subject = subjectNode.textContent?.trim();
      if (!subject) continue;

      const track = findBestTrackForThread(subjectNode);
      if (!track) continue;

      let status = subjectNode.parentElement?.querySelector(".gt-thread-status");
      if (!status) {
        status = document.createElement("span");
        status.className = "gt-thread-status";
        subjectNode.insertAdjacentElement("afterend", status);
      }

      status.className = `gt-thread-status ${track.openCount > 0 ? "gt-thread-opened" : "gt-thread-unread"}`;
      status.innerHTML = statusBadgeMarkup(track, true);
      status.title = track.openCount > 0
        ? `To ${track.recipientEmail} - ${track.openCount} receiver view${track.openCount === 1 ? "" : "s"} - last ${formatRelativeTime(track.lastOpenedAt)}`
        : `To ${track.recipientEmail} - no recipient views`;
      status.setAttribute("aria-label", status.title);
    }

    cleanupMisplacedTrackingLabels();
  }

  function isConversationSubject(subjectNode) {
    if (!(subjectNode instanceof Element)) return false;
    if (subjectNode.closest("div[role='dialog'], form[role='search'], nav, [role='navigation'], .gt-summary-modal")) return false;
    if (!subjectNode.closest("div[role='main']")) return false;

    const rect = subjectNode.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 10) return false;

    const className = subjectNode.getAttribute("class") || "";
    return className.split(/\s+/).includes("hP") || subjectNode.hasAttribute("data-thread-perm-id");
  }

  function statusBadgeMarkup(track, includeTime) {
    const count = Number(track.openCount || 0);
    const label = count > 0 ? `${count}` : "";
    const time = count > 0 && includeTime ? `<span class="gt-status-time">${escapeHtml(formatRelativeTime(track.lastOpenedAt))}</span>` : "";
    const icon = count > 0
      ? `<path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="3"></circle>`
      : `<path d="M2.5 12s3.4-6 9.5-6c2.1 0 3.9.7 5.4 1.6"></path><path d="M21.5 12s-3.4 6-9.5 6c-2.1 0-3.9-.7-5.4-1.6"></path><path d="m4 4 16 16"></path><path d="M9.9 9.9A3 3 0 0 0 14.1 14.1"></path>`;
    return `
      <span class="gt-eye-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          ${icon}
        </svg>
      </span>
      <span class="gt-status-count">${escapeHtml(label)}</span>
      ${time}
    `;
  }

  function cleanupMisplacedTrackingLabels() {
    for (const badge of document.querySelectorAll(".gt-status-badge")) {
      const row = badge.closest("tr.zA[role='row']");
      const timeCell = badge.closest("td.xW");
      const timeWrap = badge.parentElement;
      if (!row || !timeCell || !timeWrap?.matches("span[title]") || !isEmailListRow(row)) {
        badge.remove();
      }
    }

    for (const status of document.querySelectorAll(".gt-thread-status")) {
      const subjectNode = status.previousElementSibling;
      if (!subjectNode?.matches("h2") || !isConversationSubject(subjectNode)) {
        status.remove();
      }
    }
  }

  function findBestTrackForThread(subjectNode) {
    const container = subjectNode.closest("[role='main']") || document.body;
    const pageText = normalizeText(container.textContent || "");
    const subject = normalizeText(subjectNode.textContent || "");
    let best = null;
    let bestScore = -1;

    for (const track of state.tracks) {
      const trackSubject = normalizeText(track.subject);
      const body = normalizeText(track.bodyText || "").slice(0, 160);
      if (!isTrackForCurrentSender(track)) continue;
      if (!trackSubject || subject !== trackSubject) continue;
      if (!textIncludesEmailIdentity(pageText, track.recipientEmail)) continue;

      let score = 0;

      if (body && pageText.includes(body.slice(0, 60))) score += 35;

      if (score > bestScore) {
        bestScore = score;
        best = track;
      }
    }

    return best;
  }

  function formatRelativeTime(value) {
    if (!value) return "never";

    const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    const units = [
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
      ["second", 1]
    ];
    const [unit, size] = units.find((item) => seconds >= item[1]) || ["second", 1];
    const amount = Math.floor(seconds / size);
    return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
