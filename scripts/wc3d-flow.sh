#!/bin/bash
# example → PCB import → autoroute → 3D flow for visual iteration.
# Usage: bash scripts/wc3d-flow.sh [example_item_prefix]
# Default "LED + Resistor". Reloads the page fresh first.
# DOM-level clicks (Radix-safe pointer events) — robust against ref churn.
cd /home/z/my-project
PREFIX="${1:-LED + Resistor}"

agent-browser press Escape >/dev/null 2>&1 || true
agent-browser reload >/dev/null 2>&1 || true
agent-browser wait --load networkidle >/dev/null 2>&1 || true
sleep 4

dom_click() {   # open a Radix dropdown by button text
  agent-browser eval "var CLICK_TEXT='$1'; $(cat scripts/dom-click.js)" >/dev/null 2>&1
}
dom_item() {    # click a menu item by text prefix
  agent-browser eval "var ITEM_PREFIX='$1'; $(cat scripts/dom-menuitem.js)" 2>&1 | tail -1
}
dom_button() {  # plain react click by button text
  agent-browser eval "var CLICK_TEXT='$1'; $(cat scripts/dom-button.js)" >/dev/null 2>&1
}

dom_click "Examples"; sleep 2.5
RES=$(dom_item "$PREFIX")
echo "example: $RES"
case "$RES" in *clicked*) ;; *) exit 1;; esac
sleep 4

dom_button "Run"; sleep 2
dom_button "PCB Layout"; sleep 3
dom_button "Import"; sleep 5
dom_click "Auto"; sleep 1.5
dom_item "Auto-Route All" >/dev/null; sleep "${WAIT_ROUTE:-6}"
dom_button "3D View"; sleep "${WAIT_3D:-8}"
echo "flow done: example=$PREFIX"
