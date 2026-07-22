import { Hr, Link, Text } from '@react-email/components';
import { colors, CtaButton, Eyebrow, Heading, Layout, monoStack, Paragraph } from './theme.js';

/** Notification for a new incident/maintenance/announcement or an update to
 *  one. `kicker` is the type + state (e.g. "Incident · Monitoring"). */
export default function StatusNotify({
  kicker, title, body, statusUrl, unsubscribeUrl,
}: { kicker: string; title: string; body: string; statusUrl: string; unsubscribeUrl: string }) {
  return (
    <Layout preview={`${kicker}: ${title}`}>
      <Eyebrow>{kicker}</Eyebrow>
      <Heading>{title}</Heading>
      {body ? <Paragraph>{body}</Paragraph> : null}
      <CtaButton href={statusUrl}>View status page</CtaButton>
      <Hr style={{ borderColor: colors.line, margin: '4px 0 16px' }} />
      <Text style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: colors.inkSoft }}>
        You're receiving this because you subscribed to devplat status updates.{' '}
        <Link href={unsubscribeUrl} style={{ color: colors.red, fontFamily: monoStack, fontSize: 11 }}>Unsubscribe</Link>
      </Text>
    </Layout>
  );
}
