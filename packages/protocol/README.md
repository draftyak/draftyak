# Protocol package exports

Public subpaths use their exact canonical names in both the workspace and packed export maps. Adding a public module requires an explicit entry in both maps.

`@draftyak/protocol/plugin-stdio` is a Node-only entry; its implementation subpaths are private. Unknown subpaths and alternate-case aliases are not exported.
