import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { setFavicon } from "./theme.js";

try {
  setFavicon(JSON.parse(localStorage.getItem("forest-theme")).vars);
} catch (_) {
  // no saved theme yet
}

export default mount(App, { target: document.getElementById("app") });
