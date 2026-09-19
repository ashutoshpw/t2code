import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon, ServerIcon, SmartphoneIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T2ConnectUserProfilePage } from "./T2ConnectUserProfilePage";
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
      <UserButton.UserProfilePage
        label="Mobile clients"
        labelIcon={<SmartphoneIcon className="size-4" />}
        url="mobile-clients"
      >
        <MobileClientsUserProfilePage />
      </UserButton.UserProfilePage>
      <UserButton.UserProfilePage
        label="T2 Connect"
        labelIcon={<ServerIcon className="size-4" />}
        url="t3-connect"
      >
        <T2ConnectUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}

function ConfiguredT2ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useT2ConnectAuthPrompt();

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
      {authPrompt}
    </>
  );
}
