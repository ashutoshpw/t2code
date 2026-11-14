// The production icon, as GitHub shows the T2 Code app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/t2-black-web-apple-touch-180.png";

export function T2AppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
