// The wide band at the top of a profile or institution card. With no uploaded image it is the
// decorative palm gradient and wave crest; with one, the image replaces that treatment. Either way
// it carries no information the page does not already state in text, so it stays hidden from
// assistive technology.
export function IdentityBanner({ bannerUrl }: { bannerUrl: string | null }) {
  return (
    <div className={`pf-banner${bannerUrl ? " pf-banner-uploaded" : ""}`} aria-hidden="true">
      {bannerUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={bannerUrl} alt="" className="pf-banner-image" />
      ) : null}
    </div>
  );
}
