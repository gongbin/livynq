// Entry point for `child_process.fork` in development / npm installs.
import { runPluginHost } from './child.ts';

runPluginHost();
