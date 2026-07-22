import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function StatusConfirm({ confirmUrl }: { confirmUrl: string }) {
  return (
    <Layout preview="Confirm your subscription to devplat status updates.">
      <Eyebrow>Status updates</Eyebrow>
      <Heading>Confirm your subscription.</Heading>
      <Paragraph>
        You asked to receive devplat status updates — incidents, scheduled maintenance, and
        service announcements. Confirm your email to start receiving them. If this wasn't you,
        just ignore this message; nothing is sent until you confirm.
      </Paragraph>
      <CtaButton href={confirmUrl}>Confirm subscription</CtaButton>
      <FallbackLink href={confirmUrl} />
    </Layout>
  );
}
