import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon, RotateCwIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { retryClerkLoad, useClerkLoadFailed } from "./clerkLoadFailure";
import { T2_CONNECT_ACCOUNT_PAGES } from "./T2ConnectAccountPages";
import { useT2ConnectAuthPrompt } from "./useT2ConnectAuthPrompt";

export function T2ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT2ConnectSidebarSignIn />;
}

export function T2ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT2ConnectSidebarAvatar />;
}

function ConfiguredT2ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {T2_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}{" "}
    </UserButton>
  );
}

function ConfiguredT2ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const loadFailed = useClerkLoadFailed();
  const { openAuthPrompt } = useT2ConnectAuthPrompt();

  if (loadFailed) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={retryClerkLoad}>
            <RotateCwIcon />
            <span>Retry T2 Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to T2 Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </>
  );
}
