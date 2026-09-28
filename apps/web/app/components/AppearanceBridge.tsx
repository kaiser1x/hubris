"use client";

import { useEffect } from "react";
import { applyAppearance, readAppearance } from "../lib/settings";

export default function AppearanceBridge() {
  useEffect(() => {
    const syncAppearance = () => applyAppearance(readAppearance(window.localStorage), document);
    syncAppearance();
    window.addEventListener("hubris-settings-changed", syncAppearance);
    return () => window.removeEventListener("hubris-settings-changed", syncAppearance);
  }, []);

  return null;
}
