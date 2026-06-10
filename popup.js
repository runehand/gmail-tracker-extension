const dashboardUrl = document.getElementById("dashboardUrl");
const trackingEnabled = document.getElementById("trackingEnabled");
const save = document.getElementById("save");
const status = document.getElementById("status");
const openDashboard = document.getElementById("openDashboard");

chrome.storage.sync.get(["dashboardUrl", "trackingEnabled"], (values) => {
  dashboardUrl.value = values.dashboardUrl || "https://gmail-tracker-dashboard.vercel.app";
  trackingEnabled.checked = values.trackingEnabled !== false;
  openDashboard.href = dashboardUrl.value || "https://gmail-tracker-dashboard.vercel.app";
});

save.addEventListener("click", () => {
  const url = dashboardUrl.value.replace(/\/$/, "");
  chrome.storage.sync.set({ dashboardUrl: url, trackingEnabled: trackingEnabled.checked }, () => {
    openDashboard.href = url;
    status.textContent = "Saved";
    setTimeout(() => {
      status.textContent = "";
    }, 1600);
  });
});
