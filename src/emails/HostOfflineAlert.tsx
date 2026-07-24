import { Eyebrow, Heading, Layout, Paragraph } from './theme.js';

export default function HostOfflineAlert({ hostName, location, lastHeartbeat, dashboardUrl }: {
  hostName: string; location: string; lastHeartbeat: string; dashboardUrl: string;
}) {
  return (
    <Layout preview={`Host ${hostName} went offline`}>
      <Eyebrow>Ops alert</Eyebrow>
      <Heading>Host {hostName} is offline.</Heading>
      <Paragraph>
        The scheduler stopped receiving heartbeats from <strong>{hostName}</strong> ({location})
        and pulled it out of rotation. No new environments will be placed on it until it recovers.
      </Paragraph>
      <Paragraph>
        <strong>Last heartbeat:</strong> {lastHeartbeat}
      </Paragraph>
      <Paragraph>
        Check the host and its agent, then review capacity in the admin dashboard: {dashboardUrl}
      </Paragraph>
    </Layout>
  );
}
