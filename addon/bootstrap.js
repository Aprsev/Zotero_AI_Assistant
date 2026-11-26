var rootURI;
function install() {}
async function startup(data) {
  rootURI = data.rootURI;
  Services.scriptloader.loadSubScript(rootURI + "content/main.js", this);
  await AILiterature.start(rootURI);
}
function onMainWindowLoad() {}
function onMainWindowUnload() {}
function shutdown(data, reason) {
  if (reason !== APP_SHUTDOWN) AILiterature?.stop();
}
function uninstall() {}
