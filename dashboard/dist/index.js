(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !SDK.React || !window.__HERMES_PLUGINS__) {
    // Hermes dashboard shell not present; nothing to render into.
    return;
  }

  var React = SDK.React;
  var hooks = SDK.hooks || {};
    var useState = hooks.useState || function (init) {
      // Minimal useState fallback so the bundle still loads on older shells.
      var value = { current: init };
      return [value.current, function (v) { value.current = v; }];
    };
  var components = SDK.components || {};
  var Card = components.Card || "div";
  var CardHeader = components.CardHeader || "div";
  var CardTitle = components.CardTitle || "div";
  var CardContent = components.CardContent || "div";
  var fetchJSON = SDK.fetchJSON || function (url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  };

  var DEFAULT_VIEWER_URL = "http://127.0.0.1:8797";
  var START_COMMAND = "python -m omniscience_viewer";

  function h(type, props) {
    var children = Array.prototype.slice.call(arguments, 2);
    var args = [type, props || null];
    for (var i = 0; i < children.length; i++) args.push(children[i]);
    return React.createElement.apply(React, args);
  }

  function OmnisciencePage(props) {
    var state = useState({ loading: true, health: null, error: null });
    var health = state[0].health, error = state[0].error, loading = state[0].loading;
    var setState = function (patch) {
      state[1](function (prev) { return Object.assign({}, prev, patch); });
    };

    hooks.useEffect(function () {
      var alive = true;
      fetchJSON("/api/plugins/omniscience/health")
        .then(function (data) { if (alive) setState({ loading: false, health: data, error: null }); })
        .catch(function (err) { if (alive) setState({ loading: false, error: err && err.message ? err.message : String(err) }); });
      return function () { alive = false; };
    }, []);

    var viewerUrl = (health && health.viewer_url) || DEFAULT_VIEWER_URL;
    // /omni links open this tab as /omniscience?session=<id>; hand the chat on to the viewer.
    var linkedSession = new URLSearchParams(window.location.search).get("session");
    var frameUrl = linkedSession
      ? viewerUrl.replace(/\/+$/, "") + "/?session=" + encodeURIComponent(linkedSession)
      : viewerUrl;

    var children = [];

    if (loading) {
      children.push(h(Card, { key: "loading" },
        h(CardContent, null, h("p", { className: "text-sm text-muted-foreground" }, "Loading Omniscience status…"))
      ));
    } else if (error && !health) {
      children.push(h(Card, { key: "err" },
        h(CardHeader, null, h(CardTitle, null, "Omniscience backend unreachable")),
        h(CardContent, null,
          h("p", { className: "text-sm text-muted-foreground" }, String(error)),
          h("p", { className: "text-xs text-muted-foreground", style: { marginTop: "0.5rem" } },
            "Start the viewer with: " + START_COMMAND)
        )
      ));
    } else {
      var ok = health && health.ok;
      children.push(h(Card, { key: "status" },
        h(CardHeader, null, h(CardTitle, null, "Omniscience")),
        h(CardContent, null,
          h("p", { className: "text-sm" },
            ok
              ? "Recording events: " + (health.events || 0) +
                " · last " + (health.last_ts ? new Date(health.last_ts * 1000).toLocaleString() : "n/a")
              : "No event database yet — run the agent once to start recording."),
          h("p", { className: "text-xs text-muted-foreground", style: { marginTop: "0.25rem" } },
            "DB: " + (health && health.db_path ? health.db_path : "unknown")),
          !ok && h("p", { className: "text-xs text-muted-foreground", style: { marginTop: "0.5rem" } },
            "Start the viewer with: " + START_COMMAND)
        )
      ));
    }

    // The graph itself lives in the standalone viewer; embed it.
    children.push(h(Card, { key: "viewer", style: { marginTop: "1rem" } },
      h(CardHeader, null, h(CardTitle, null, "Activity graph")),
      h(CardContent, null,
        h("iframe", {
          src: frameUrl,
          title: "Omniscience viewer",
          style: { width: "100%", height: "70vh", border: "1px solid var(--color-border, #333)", borderRadius: "8px" }
        }),
        h("p", { className: "text-xs text-muted-foreground", style: { marginTop: "0.5rem" } },
          "If the graph is blank, start the viewer: " + START_COMMAND + "  (expects " + viewerUrl + ")")
      )
    ));

    return h("div", { className: "p-4 space-y-4" }, children);
  }

  window.__HERMES_PLUGINS__.register("omniscience", OmnisciencePage);
})();
