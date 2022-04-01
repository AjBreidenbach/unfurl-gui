import Vue from 'vue';
import VueRouter from 'vue-router';
import { joinPaths } from '~/lib/utils/url_utility';
import routes from './routes';
import { PageNotFound } from '../../vue_shared/oc-components'

Vue.use(VueRouter);
routes.push({ path: "*", component: PageNotFound })

export default function createRouter() {
    /*
    if(!base)
    throw new Error(`
        Could not initialize router without a projectPath.
        If you are on unfurl-gui, make sure you are running apollo:start before serve so that live/db.json is populated
    `)
    */
    const router = new VueRouter({
        mode: 'history',
        base: joinPaths(gon.relative_url_root || '', `dashboard`),
        routes,

    });


    router.name = 'dashboard'

    /*
    router.beforeEach((to, from, next) => {
        if(router.app.$store) {
            router.app.$store.getters.getRouterHook(to, from, next)
        }
        else next()
    })

*/
    return router;
}
