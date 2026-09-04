import { Tab, TabList, Tooltip, makeStyles } from '@fluentui/react-components';
import {
  ConferenceRoomRegular,
  FlowRegular,
  LayerRegular,
  ImageRegular,
  ShoppingBagRegular,
  DatabaseRegular,
  SettingsRegular,
  WrenchScrewdriverRegular,
} from '@fluentui/react-icons';
import { useLocation, useNavigate } from 'react-router-dom';

const useStyles = makeStyles({
  container: {
    height: '100%',
  },
  item: {
    width: '64px',
    height: '64px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export const MenuBar = () => {
  const classes = useStyles();

  const { pathname } = useLocation();
  const menu = pathname.split('/')[1] || 'settings';

  const navigate = useNavigate();

  return (
    <TabList
      className={classes.container}
      selectedValue={menu}
      onTabSelect={(_, { value }) => navigate(value as string)}
      size="large"
      vertical
    >
      <Tooltip content="Gates" relationship="label" positioning="after">
        <Tab
          className={classes.item}
          icon={<ConferenceRoomRegular />}
          value="gates"
          aria-label="Gates"
        />
      </Tooltip>
      <Tooltip content="Content pipeline" relationship="label" positioning="after">
        <Tab
          className={classes.item}
          icon={<FlowRegular />}
          value="content"
          aria-label="Content pipeline"
        />
      </Tooltip>
      <Tooltip content="Decks" relationship="label" positioning="after">
        <Tab
          className={classes.item}
          icon={<LayerRegular />}
          value="decks"
          aria-label="Decks"
        />
      </Tooltip>
      <Tooltip content="Shop packs" relationship="label" positioning="after">
        <Tab className={classes.item} icon={<ShoppingBagRegular />} value="shop" aria-label="Shop packs" />
      </Tooltip>
      <Tooltip
        content="Structure Decks"
        relationship="label"
        positioning="after"
      >
        <Tab
          className={classes.item}
          icon={<LayerRegular />}
          value="structure-decks"
          aria-label="Structure Decks"
        />
      </Tooltip>
      <Tooltip content="Regulations" relationship="label" positioning="after">
        <Tab className={classes.item} icon={<LayerRegular />} value="regulations" aria-label="Regulations" />
      </Tooltip>
      <Tooltip content="Localization and assets" relationship="label" positioning="after">
        <Tab className={classes.item} icon={<ImageRegular />} value="localization-assets" aria-label="Localization and assets" />
      </Tooltip>
      <Tooltip content="Catalog administration" relationship="label" positioning="after">
        <Tab className={classes.item} icon={<DatabaseRegular />} value="catalog" aria-label="Catalog administration" />
      </Tooltip>
      <Tooltip content="Utilities" relationship="label" positioning="after">
        <Tab
          className={classes.item}
          icon={<WrenchScrewdriverRegular />}
          value="utilities"
          aria-label="Utilities"
        />
      </Tooltip>
      <Tooltip content="Settings" relationship="label" positioning="after">
        <Tab
          className={classes.item}
          icon={<SettingsRegular />}
          value="settings"
          aria-label="Settings"
        />
      </Tooltip>
    </TabList>
  );
};
