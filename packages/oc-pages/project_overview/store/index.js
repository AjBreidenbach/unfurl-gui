import Vue from "vue";
import Vuex from "vuex";
import createLogger from "vuex/dist/logger";
import environments from "./modules/environments";
import project from "./modules/project";
import deployment_template_updates from "./modules/deployment_template_updates"
import templateResources from "./modules/template_resources";
import project_application_blueprint from './modules/project_application_blueprint'
import deployment_info from '../../dashboard/store/modules/deployment-info'
import misc from './modules/misc'
import deployments from './modules/deployments'

Vue.use(Vuex);

const debug = process.env.NODE_ENV !== "production";

const store = new Vuex.Store({
    modules: {
        misc,
        deployments,
        environments,
        project,
        templateResources,
        deployment_template_updates,
        project_application_blueprint,
        deployment_info
    },
    strict: debug,
    plugins: debug && process.env.VUEX_LOGGER === "true" ? [createLogger()] : [],
});

export default store;
