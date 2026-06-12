import { useEffect, useState } from "react";
import { App } from "./App";
import { Landing } from "./Landing";
import { Literature } from "./Literature";

// Tiny hash router: #/ -> landing, #/reasoning -> the graph app, #/literature -> lit review.
// Hash routing needs no server route config and works with the static build.
function currentPath(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

export function Root() {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (path.startsWith("/reasoning")) return <App />;
  if (path.startsWith("/literature")) return <Literature />;
  return <Landing />;
}
