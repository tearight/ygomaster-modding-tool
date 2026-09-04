import { createHashRouter, redirect } from 'react-router-dom';

import { RootErrorBoundary } from './components/error/RootErrorBoundary';
import { DeckList } from './components/deck/DeckList';
import { GateCreate } from './components/gate/GateCreate';
import { GateDetail } from './components/gate/GateDetail';
import { GateList } from './components/gate/GateList';
import { ContentPipeline } from './components/content/ContentPipeline';
import { ShopAuthoring } from './components/shop/ShopAuthoring';
import { Layout } from './components/layout/Layout';
import { SettingsDetail } from './components/settings/SettingsDetail';
import { StructureAuthoring } from './components/structure-deck/StructureAuthoring';
import { RegulationAuthoring } from './components/regulation/RegulationAuthoring';
import { LocalizationAssetAuthoring } from './components/localization/LocalizationAssetAuthoring';
import { CatalogAdministration } from './components/catalog/CatalogAdministration';
import { Utilities } from './components/utilities/Utilities';

export const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: <RootErrorBoundary />,
    children: [
      {
        index: true,
        loader: () => redirect('/settings'),
      },
      {
        path: 'gates',
        element: <GateList />,
      },
      {
        path: 'gates/create',
        element: <GateCreate />,
      },
      {
        path: 'gates/:id',
        element: <GateDetail />,
      },
      {
        path: 'gates/:id/chapters/:chapterId',
        element: <GateDetail />,
      },
      {
        path: 'decks',
        element: <DeckList />,
      },
      {
        path: 'shop',
        element: <ShopAuthoring />,
      },
      {
        path: 'structure-decks',
        element: <StructureAuthoring />,
      },
      {
        path: 'regulations',
        element: <RegulationAuthoring />,
      },
      {
        path: 'localization-assets',
        element: <LocalizationAssetAuthoring />,
      },
      {
        path: 'catalog',
        element: <CatalogAdministration />,
      },
      {
        path: 'utilities',
        element: <Utilities />,
      },
      {
        path: 'content',
        element: <ContentPipeline />,
      },
      {
        path: 'settings',
        element: <SettingsDetail />,
      },
    ],
  },
]);
