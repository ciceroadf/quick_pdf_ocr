// src/background.js
var APP_URL = chrome.runtime.getURL("app.html");
chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: APP_URL });
});
