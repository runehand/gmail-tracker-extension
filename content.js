(function () {
  const DEFAULT_URL = "http://localhost:3000";
  const state = {
    dashboardUrl: DEFAULT_URL,
    trackingEnabled: true,
    tracks: [],
    lastOpenCount: new Map()
  };
  const trackingPromises = new WeakMap();

  chrome.storage.sync.get(["dashboardUrl", "trackingEnabled"], (values) => {
    state.dashboardUrl = (values.dashboardUrl || DEFAULT_URL).replace(/\/$/, "");
    state.trackingEnabled = values.trackingEnabled !== false;
    renderPanel();
    refreshTracks();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.dashboardUrl) state.dashboardUrl = changes.dashboardUrl.newValue.replace(/\/$/, "");
    if (changes.trackingEnabled) state.trackingEnabled = changes.trackingEnabled.newValue !== false;
    renderPanel();
    refreshTracks();
  });

  setInterval(() => {
    enhanceComposeWindows();
    decorateEmailRows();
  }, 1200);

  setInterval(refreshTracks, 10000);

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
          body: JSON.stringify({ senderEmail, recipientEmail, subject, gmailMessageKey, sentAt: now })
        });

        if (!response.ok) throw new Error(`Tracker backend returned ${response.status}`);
        const data = await response.json();
        const marker = markers.find((item) => item.recipientEmail === recipientEmail);
        const image = marker?.image || (marker?.markerId ? body.querySelector(`img[data-gt-marker="${marker.markerId}"]`) : null);
        if (image) {
          image.setAttribute("src", data.pixelUrl);
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

    setTimeout(refreshTracks, 1500);
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
          src="${escapeHtml(pixelUrl || pendingSrc)}"
          width="100"
          height="100"
          style="display:block;width:100px;height:100px;object-fit:contain;"
          alt="Tracking pixel for ${escapeHtml(recipientEmail)}"
          ${trackId ? `data-gt-pixel="${escapeHtml(trackId)}"` : ""}
        >
      </div>
    `;
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
    } catch {
      // Dashboard may be offline while Gmail is open.
    }
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
    let panel = document.querySelector(".gt-panel");
    if (!panel) {
      panel = document.createElement("aside");
      panel.className = "gt-panel";
    }

    const host = getPanelHost();
    if (host && panel.parentElement !== host) {
      host.appendChild(panel);
    } else if (!host && !panel.parentElement) {
      document.body.prepend(panel);
    }

    const rows = state.tracks.slice(0, 8).map((track) => `
      <div class="gt-panel-row">
        <strong>${escapeHtml(track.subject || "(No subject)")}</strong>
        <span>${escapeHtml(track.recipientEmail)} · ${track.openCount > 0 ? `Opened ${track.openCount}x` : "Unread"}</span>
      </div>
    `).join("");

    panel.innerHTML = `
      <header>
        <span>Tracking</span>
        <a href="${escapeHtml(state.dashboardUrl)}" target="_blank" rel="noreferrer">Dashboard</a>
      </header>
      ${rows || '<div class="gt-panel-row"><span>No tracked emails yet</span></div>'}
    `;
    positionPanelNearSearch(panel);
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

  function positionPanelNearSearch(panel) {
    const search = document.querySelector("form[role='search']");
    if (!search) return;

    const rect = search.getBoundingClientRect();
    const left = Math.min(rect.right + 12, window.innerWidth - 340);
    panel.style.top = `${Math.max(8, rect.top + 2)}px`;
    panel.style.left = `${Math.max(12, left)}px`;
  }

  function decorateEmailRows() {
    if (!state.tracks.length) return;
    const rows = document.querySelectorAll("tr[role='row']");
    for (const row of rows) {
      if (row.querySelector(".gt-status-badge")) continue;
      const text = row.textContent || "";
      const track = state.tracks.find((item) => item.subject && text.includes(item.subject));
      if (!track) continue;

      const subjectCell = row.querySelector("[role='link']") || row.querySelector("td");
      if (!subjectCell) continue;

      const badge = document.createElement("span");
      badge.className = `gt-status-badge ${track.openCount > 0 ? "gt-status-opened" : "gt-status-unread"}`;
      badge.textContent = track.openCount > 0 ? "Opened" : "Unread";
      subjectCell.appendChild(badge);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
