import { useParams } from 'react-router';
import { Placeholder } from './Placeholder';

export default function ApplicationPage() {
  const { id = '' } = useParams();
  return <Placeholder titleKey="page.application.title" detail={id} back={{ to: '/applications', labelKey: 'nav.applications' }} />;
}
