// Must stay first: the render counter and behavior probe wrap the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import "./src/features/development/behavior-probe-entry";
// Next, so errors thrown while the rest of the app loads are recorded too.
import "./src/features/observability/observe";
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

// Enables iOS FormSheet sizing for nested native stacks in non-fitToContents sheets.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

if (__DEV__ && process.env.EXPO_PUBLIC_T2_SPACES_FEASIBILITY === "1") {
  const { SpacesFeasibilityApp } =
    require("./src/features/spaces/SpacesFeasibilityApp") as typeof import("./src/features/spaces/SpacesFeasibilityApp");
  registerRootComponent(SpacesFeasibilityApp);
} else {
  const { default: App } = require("./src/App") as typeof import("./src/App");
  registerRootComponent(App);
}
