import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { ListRow } from "../../components/ui/ListRow";

export function SpacesEntry() {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  return (
    <ListRow
      icon="doc.text"
      label="Spaces"
      description="Browse pages"
      onPress={() => navigation.push("SpacesLibrary")}
    />
  );
}
