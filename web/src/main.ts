import Aura from "@primeuix/themes/aura";
import "maplibre-gl/dist/maplibre-gl.css";
import { setWorkerUrl } from "maplibre-gl";
// MapLibre 6 loads its worker from a file next to its own module. Vite bundles
// that module into a hashed chunk, so the sibling path 404s and no track is
// ever drawn. Ship the worker as an asset and point MapLibre at it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import PrimeVue from "primevue/config";
import { createApp } from "vue";
import App from "./App.vue";

setWorkerUrl(workerUrl);

createApp(App)
  .use(PrimeVue, { theme: { preset: Aura } })
  .mount("#app");
