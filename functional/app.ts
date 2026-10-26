import { App } from "aws-cdk-lib";
import { cleanDeskPolicy } from "./clean-desk-policy.ts";
import { deployTestStack } from "./stack.ts";

const app = new App();
cleanDeskPolicy(app);
deployTestStack(app);
app.synth();
