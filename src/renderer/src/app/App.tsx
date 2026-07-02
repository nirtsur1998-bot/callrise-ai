import { useState } from 'react'
import AppShell from './AppShell'
import { Sidebar } from '@renderer/features/navigation/Sidebar'
import { CopilotPanel } from '@renderer/features/copilot/CopilotPanel'
import { HomeView } from '@renderer/features/home/HomeView'
import { PlaceholderView } from '@renderer/components/PlaceholderView'
import { NAV_ITEMS, type NavId } from '@renderer/features/navigation/nav-items'

function App(): React.JSX.Element {
  // Which sidebar item is selected. Today only "Home" has real content;
  // the rest show a tasteful placeholder until we build them.
  const [active, setActive] = useState<NavId>('home')
  const activeItem = NAV_ITEMS.find((item) => item.id === active) ?? NAV_ITEMS[0]

  return (
    <AppShell
      title={activeItem.label}
      sidebar={<Sidebar active={active} onSelect={setActive} />}
      copilot={<CopilotPanel />}
    >
      {active === 'home' ? (
        <HomeView />
      ) : (
        <PlaceholderView title={activeItem.label} icon={activeItem.icon} />
      )}
    </AppShell>
  )
}

export default App
