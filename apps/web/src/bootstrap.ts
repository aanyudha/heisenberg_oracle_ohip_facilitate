// Keep this entry independent of React so module-load failures remain visible.
function startupFailure() {
  const root = document.getElementById("root");
  if (!root) return;
  root.replaceChildren();
  const panel = document.createElement("main");
  panel.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = "Application could not start";
  const detail = document.createElement("p");
  detail.textContent =
    "Reload this page. If the problem continues, contact your administrator to check the application build and connection.";
  const reload = document.createElement("a");
  reload.href = window.location.pathname;
  reload.textContent = "Reload application";
  panel.append(heading, detail, reload);
  root.append(panel);
}
void import("./boot").catch(startupFailure);
