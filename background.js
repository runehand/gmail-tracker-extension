chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["dashboardUrl"], (values) => {
    if (!values.dashboardUrl) {
      chrome.storage.sync.set({ dashboardUrl: "http://localhost:3000", trackingEnabled: true });
    }
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TRACK_OPENED_NOTIFICATION") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Email opened",
      message: message.subject ? `${message.subject} was opened` : "A tracked email was opened"
    });
  }
});
