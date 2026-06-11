(function () {
  const DEFAULT_URL = "https://gmail-tracker-dashboard.vercel.app";
  const state = {
    dashboardUrl: DEFAULT_URL,
    trackingEnabled: true,
    tracks: [],
    lastOpenCount: new Map(),
    senderViewsMarked: new Map(),
    isRefreshing: false
  };
  const trackingPromises = new WeakMap();

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

  function getAccountEmail() {
    const accountNode = document.querySelector("a[aria-label*='Google Account']") || document.querySelector("[email]");
    const label = accountNode?.getAttribute("aria-label") || accountNode?.getAttribute("email") || "";
    const match = label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match?.[0] || "unknown@gmail.com";
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
            await insertTrackingPixels(compose);
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

  async function insertTrackingPixels(compose) {
    if (compose.dataset.gtTracked === "true") return;
    if (trackingPromises.has(compose)) return trackingPromises.get(compose);

    const body = getMessageBody(compose);
    if (!body) return;

    const promise = createTrackingPixels(compose, body);
    trackingPromises.set(compose, promise);
    try {
      await promise;
    } finally {
      trackingPromises.delete(compose);
    }
  }

  async function createTrackingPixels(compose, body) {
    compose.dataset.gtTrackingPending = "true";

    const senderEmail = getAccountEmail();
    const subject = compose.querySelector("input[name='subjectbox']")?.value || "";
    const recipients = getRecipients(compose);
    const targets = [recipients[0] || "unknown-recipient"];
    const now = new Date().toISOString();
    const markers = ensureTrackingMarkers(body, targets);

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
        const marker = markers.find((item) => item.recipientEmail === recipientEmail);
        const image = marker?.image || (marker?.markerId ? body.querySelector(`img[data-gt-marker="${marker.markerId}"]`) : null);
        if (image) {
          image.setAttribute("data-gt-src", data.pixelUrl);
          image.setAttribute("data-gt-pixel", data.track.id);
          image.removeAttribute("data-gt-marker");
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
    const subject = compose.querySelector("input[name='subjectbox']")?.value || "";
    const content = getEmailContent(compose);
    const recipients = getRecipients(compose);
    const recipientEmail = recipients[0] || "unknown-recipient";
    const images = Array.from(compose.querySelectorAll(".gt-dev-pixel img[data-gt-pixel]"));

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

    return {
      html: clone.innerHTML.trim(),
      text: (clone.textContent || "").trim()
    };
  }

  function ensureTrackingMarkers(body, targets) {
    const existingImages = Array.from(body.querySelectorAll(".gt-dev-pixel img"));
    if (existingImages.length) {
      return existingImages.map((image, index) => ({
        markerId: image.getAttribute("data-gt-marker"),
        recipientEmail: targets[index] || targets[0],
        image
      }));
    }

    return targets.map((recipientEmail) => {
      const markerId = `gt-${crypto.randomUUID()}`;
      body.insertAdjacentHTML("beforeend", createTrackingMarker("", "", recipientEmail, markerId));
      const image = body.querySelector(`img[data-gt-marker="${markerId}"]`);
      return { markerId, recipientEmail, image };
    });
  }

  function createTrackingMarker(pixelUrl, trackId, recipientEmail, markerId) {
    const pendingSrc = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='%23fff5f7' stroke='%23e11d48' stroke-width='4'/%3E%3Ctext x='50' y='46' text-anchor='middle' font-size='11' font-family='Arial' font-weight='700' fill='%23e11d48'%3ETracking%3C/text%3E%3Ctext x='50' y='62' text-anchor='middle' font-size='11' font-family='Arial' font-weight='700' fill='%23e11d48'%3EPixel%3C/text%3E%3C/svg%3E";
    return `
      <div class="gt-dev-pixel" contenteditable="false" style="display:inline-flex;position:relative;align-items:center;justify-content:center;width:100px;height:100px;margin:8px 0;border:2px solid #e11d48;box-sizing:border-box;color:#e11d48;font:700 11px Arial,sans-serif;background:#fff5f7;">
        <img
          ${markerId ? `data-gt-marker="${escapeHtml(markerId)}"` : ""}
          src="${escapeHtml(pendingSrc)}"
          ${pixelUrl ? `data-gt-src="${escapeHtml(pixelUrl)}"` : ""}
          width="100"
          height="100"
          style="display:block;width:100px;height:100px;object-fit:contain;"
          alt="Tracking pixel for ${escapeHtml(recipientEmail)}"
          ${trackId ? `data-gt-pixel="${escapeHtml(trackId)}"` : ""}
        >
      </div>
    `;
  }

  function activateTrackingPixels(compose) {
    for (const image of compose.querySelectorAll(".gt-dev-pixel img[data-gt-src]")) {
      image.setAttribute("src", image.getAttribute("data-gt-src"));
      image.removeAttribute("data-gt-src");
    }
    setTimeout(markSenderSideViews, 1500);
    setTimeout(markSenderSideViews, 5000);
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
        const response = await fetch(`${state.dashboardUrl}/api/tracks`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        state.tracks = data.tracks || [];
        notifyNewOpens(state.tracks);
        renderPanel();
        decorateEmailRows();
        decorateOpenEmailViews();
    } catch {
      // Dashboard may be offline while Gmail is open.
    }
  }

  async function markSenderSideViews() {
    const trackIds = findTrackingIdsInPage();
    if (!trackIds.length) return;

    const now = Date.now();
    for (const trackId of trackIds) {
      const lastMarkedAt = state.senderViewsMarked.get(trackId) || 0;
      if (now - lastMarkedAt < 8000) continue;
      state.senderViewsMarked.set(trackId, now);

      try {
        await fetch(`${state.dashboardUrl}/api/tracks/${trackId}/sender-view`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "gmail_sender_view", detectedAt: new Date(now).toISOString() })
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
    renderSummaryModal(false);
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
    if (!search) return;

    const rect = search.getBoundingClientRect();
    const left = Math.min(rect.right + 12, window.innerWidth - 52);
    launcher.style.top = `${Math.max(8, rect.top + 4)}px`;
    launcher.style.left = `${Math.max(12, left)}px`;
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
      badge.textContent = track.openCount > 0
        ? `Viewed ${track.openCount}x - ${formatRelativeTime(track.lastOpenedAt)}`
        : "No view";
      badge.title = track.openCount > 0
        ? `Last recipient open ${formatRelativeTime(track.lastOpenedAt)}`
        : "No recipient opens yet";
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
    const rowEmail = normalizeText(row.querySelector("[email]")?.getAttribute("email") || "");
    const rowTime = getRowTimestamp(row);

    let best = null;
    let bestScore = 0;
    let bestHasMessageMatch = false;

    for (const track of state.tracks) {
      if (usedTrackIds.has(track.id)) continue;

      const subject = normalizeText(track.subject);
      const body = normalizeText(track.bodyText || "");
      const recipient = normalizeText(track.recipientEmail);
      const sender = normalizeText(track.senderEmail);
      let score = 0;
      let hasMessageMatch = false;

      if (subject && rowSubject === subject) {
        score += 70;
        hasMessageMatch = true;
      } else if (subject && rowSubject.includes(subject)) {
        score += 45;
        hasMessageMatch = true;
      } else if (subject && rowText.includes(subject)) {
        score += 25;
        hasMessageMatch = true;
      }

      const bodySample = body.slice(0, 120);
      if (bodySample && rowSnippet && (bodySample.includes(rowSnippet) || rowSnippet.includes(bodySample.slice(0, 40)))) {
        score += 35;
        hasMessageMatch = true;
      }
      if (recipient && rowText.includes(recipient)) score += 18;
      if (sender && (rowText.includes(sender) || rowEmail === sender)) score += 12;

      if (rowTime) {
        const minutes = Math.abs(rowTime.getTime() - new Date(track.sentAt || track.createdAt).getTime()) / 60000;
        if (minutes <= 2) score += 20;
        else if (minutes <= 20) score += 10;
        else if (minutes <= 1440) score += 4;
      }

      if (score > bestScore) {
        bestScore = score;
        best = track;
        bestHasMessageMatch = hasMessageMatch;
      }
    }

    return bestScore >= 50 && bestHasMessageMatch ? best : null;
  }

  function getRowTimestamp(row) {
    const title = row.querySelector("td.xW span[title]")?.getAttribute("title") || "";
    const parsed = Date.parse(title);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  function normalizeText(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
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
      status.textContent = track.openCount > 0
        ? `Viewed ${track.openCount} - last ${formatRelativeTime(track.lastOpenedAt)}`
        : "No recipient views";
      status.title = `To ${track.recipientEmail}`;
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
    let bestScore = 0;

    for (const track of state.tracks) {
      const trackSubject = normalizeText(track.subject);
      const body = normalizeText(track.bodyText || "").slice(0, 160);
      let score = 0;

      if (trackSubject && subject === trackSubject) score += 60;
      else if (trackSubject && subject.includes(trackSubject)) score += 40;
      if (body && pageText.includes(body.slice(0, 60))) score += 35;
      if (track.recipientEmail && pageText.includes(normalizeText(track.recipientEmail))) score += 12;

      if (score > bestScore) {
        bestScore = score;
        best = track;
      }
    }

    return bestScore >= 45 ? best : null;
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
