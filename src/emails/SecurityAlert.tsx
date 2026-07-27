import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function SecurityAlert({ headline, detail, whenText, contextLines, profileUrl }: {
  headline: string; detail: string; whenText: string; contextLines: string[]; profileUrl: string;
}) {
  return (
    <Layout preview={headline}>
      <Eyebrow>Security</Eyebrow>
      <Heading>{headline}</Heading>
      <Paragraph>{detail}</Paragraph>
      <Paragraph>
        <strong>When:</strong> {whenText}
        {contextLines.map((line) => <><br />{line}</>)}
      </Paragraph>
      <Paragraph>
        If this was you, nothing to do. If it wasn&rsquo;t, change your password now and review your
        active sessions — signing out every other device takes one click.
      </Paragraph>
      <CtaButton href={profileUrl}>Review account security</CtaButton>
      <FallbackLink href={profileUrl} />
    </Layout>
  );
}
