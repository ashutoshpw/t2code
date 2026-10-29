import { SPACE_PAGE_SHARE_PAGE_PATH } from "@t2code/contracts";

export function isSharedPage(): boolean {
  return window.location.pathname === SPACE_PAGE_SHARE_PAGE_PATH;
}
