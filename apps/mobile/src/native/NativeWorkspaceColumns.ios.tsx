import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
const nativeControls = requireOptionalNativeModule<{ readonly supportsWorkspaceColumns?: boolean }>(
  "T2NativeControls",
);
export const NATIVE_WORKSPACE_COLUMNS_SUPPORTED =
  Platform.OS === "ios" && Platform.isPad && nativeControls?.supportsWorkspaceColumns === true;
