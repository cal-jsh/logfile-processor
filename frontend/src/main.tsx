import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { OpenAPI } from "../openapi/client/core/OpenAPI";

OpenAPI.BASE = "http://localhost:8080";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
