<script>
import {GlDropdown, GlDropdownItem, GlDropdownDivider} from '@gitlab/ui'
import {ErrorSmall, DetectIcon} from 'oc_vue_shared/components/oc'
import {mapGetters, mapActions} from 'vuex'

const DEPLOY_INTO_ENV_MIN_ACCESS = 30

let GLOBAL_providersLoaded = false

export default {
    name: 'EnvironmentSelection',
    props: {
        provider: String,
        error: String,
        value: Object,
        environmentCreation: Boolean,
    },
    data() {return {}},
    components: {
        GlDropdown,
        GlDropdownItem,
        GlDropdownDivider,
        ErrorSmall,
        DetectIcon,
    },
    watch: {
        env: {
            immediate: true,
            handler(env) {
                this.$emit('input', env)
            }
        }
    },
    methods: {
        ...mapActions(['loadAdditionalProviders'])
    },
    computed: {
        ...mapGetters([ 'lookupEnvironment', 'getMatchingEnvironments', 'getHomeProjectPath', 'additionalDashboardProviders' ]),
        matchingEnvironments() {
            return this.getMatchingEnvironments(this.provider).filter(env => env._dashboard == this.getHomeProjectPath)
        },
        externalEnvironments() {
            return (this.additionalDashboardProviders || [])
                .map(
                    dash => Object.entries(dash.providersByEnvironment)
                        .filter(([env, providers]) => providers && providers.includes(this.provider))
                        .map(([env, _]) => ({name: env, _dashboard: dash.fullPath, type: dash.primaryProviderFor(env)}))
                ).flat()
        },
        env() {
            let result
            if(typeof this.value == 'string') {
                result = this.lookupEnvironment(this.value || this.defaultEnvironmentName)
            } else {
                result = this.value
            }

            if(result?.name && this.matchingEnvironments.concat(this.externalEnvironments).some(env => env.name == result.name)) {
                return result
            }

            return null
        }
    },
    async beforeMount() {
        if(!GLOBAL_providersLoaded) {
            await this.loadAdditionalProviders({accessLevel: DEPLOY_INTO_ENV_MIN_ACCESS})
        }
        GLOBAL_providersLoaded = true
    }
}

</script>
<template>
    <div class="dropdown-parent">
        <gl-dropdown v-if="environmentCreation || matchingEnvironments.length > 0" data-testid="deployment-environment-select" ref="dropdown">
            <template #button-text>
                <span class="d-flex align-items-center" style="line-height: 1.1">
                    <!-- detect icon for thin copy of env -->
                    <detect-icon v-if="env && env.type" class="mr-2" no-default :type="env.type" />
                    <!-- detect icon loaded env -->
                    <detect-icon v-else-if="env" class="mr-2" no-default :env="env" />

                    <span>{{(env && env.name) || __("Select")}}</span>
                </span>
            </template>

            <div v-if="matchingEnvironments.length + externalEnvironments.length > 0">
                <gl-dropdown-item :data-testid="`deployment-environment-selection-${env.name}`" v-for="env in matchingEnvironments" @click="$emit('input', env)" :key="env.name">
                    <div class="d-flex align-items-center"><detect-icon class="mr-2" :env="env" />{{ env.name }}</div>
                </gl-dropdown-item>
                <gl-dropdown-item :data-testid="`deployment-environment-selection-${env._dashboard}/${env.name}`" v-for="env in externalEnvironments" @click="$emit('input', env)" :key="env._dashboard + '/' + env.name">
                    <div class="d-flex align-items-center"><detect-icon class="mr-2" :type="env.type" />{{ env._dashboard }} <br> {{ env.name }}</div>
                </gl-dropdown-item>

                <gl-dropdown-divider v-if="environmentCreation" />
            </div>
            <gl-dropdown-item class="disabled" v-if="environmentCreation" @click="$emit('createNewEnvironment')">
                <div style="white-space: pre">{{ __("Create new environment") }}</div>
            </gl-dropdown-item>
        </gl-dropdown>
        <div v-else>No environments are available.</div>
        <error-small :message="error"/>
    </div>
</template>
