import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Keyboard: { dismiss: () => {} },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
// React Navigation throws this outside a navigator, as for the Arrange threads sheet.
const navigation = vi.hoisted(() => ({ available: false }));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => {
    if (!navigation.available) throw new Error("Couldn't find a navigation object.");
    return true;
  },
}));
vi.mock("./AndroidScreenHeader.android", () => ({
  AndroidScreenHeader: (props: {
    readonly title: string;
    readonly actions?: ReadonlyArray<{
      readonly accessibilityLabel: string;
      readonly overflowOnly?: boolean;
    }>;
  }) => (
    <h1>
      {props.title}
      {props.actions?.map((action) => (
        <button key={action.accessibilityLabel} data-overflow={action.overflowOnly === true}>
          {action.accessibilityLabel}
        </button>
      ))}
    </h1>
  ),
}));
vi.mock("./WorkspaceAppBar.android", () => ({
  useHasWorkspaceAppBar: () => false,
  WorkspaceAppBar: () => null,
}));
vi.mock("./Menu", () => ({ Menu: (props: { readonly children?: ReactNode }) => props.children }));
vi.mock("./ScreenHeaderButton.android", () => ({ ScreenHeaderButton: () => null }));
vi.mock("./SearchField", () => ({ SearchField: () => null }));
vi.mock("./Button", () => ({ Button: () => null }));
vi.mock("../../features/layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 48, paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../features/layout/useSidebarToggle", () => ({ useSidebarToggle: () => null }));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { AppBar } from "./AppBar.android";

const roots: Root[] = [];

afterEach(() => {
  navigation.available = false;
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

it("renders a sheet bar without search outside a navigation container", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(<AppBar sheet title="Arrange threads" />));

  expect(container.textContent).toBe("Arrange threads");
});

it("puts the search refresh in the toolbar when refreshInToolbar is set", () => {
  navigation.available = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() =>
    root.render(
      <AppBar
        title="Archived"
        search={{
          mode: "inline",
          value: "",
          onChangeText: () => {},
          placeholder: "Search",
          onRefresh: () => {},
          refreshInToolbar: true,
          refreshAccessibilityLabel: "Refresh archived threads",
        }}
      />,
    ),
  );

  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Refresh archived threads");
  expect(button?.dataset.overflow).toBe("false");
});
