import { useParams } from 'react-router';
import { Placeholder } from './Placeholder';

export default function ServerPage() {
  const { id = '' } = useParams();
  return <Placeholder titleKey="page.server.title" detail={id} back={{ to: '/servers', labelKey: 'nav.servers' }} />;
}
